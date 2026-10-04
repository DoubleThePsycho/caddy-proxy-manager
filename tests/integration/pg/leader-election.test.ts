/**
 * The job leader election (src/lib/db/leader.ts) on a real PostgreSQL, with
 * two electors on two dedicated connections standing for two replicas:
 * exactly one leads; the follower takes over after the leader releases the
 * lock and after the leader's session is killed (pg_terminate_backend); a
 * leader whose heartbeat fails stops its jobs while its session still holds
 * the lock, before the follower can take it; and the leader-only jobs
 * (LeaderOnlyJobs in src/lib/background-jobs.ts) never run on both.
 *
 * Runs in the postgres Vitest project (TEST_DB_DIALECT=postgres).
 */
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { testDbIsPostgres } from '../../helpers/db';
import { LeaderElector } from '../../../src/lib/db/leader';
import { ADVISORY_LOCK_NAMESPACE, readPostgresConfig } from '../../../src/lib/db/postgres';
import { LeaderOnlyJobs, type BackgroundJob } from '../../../src/lib/background-jobs';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<number> {
  const started = Date.now();
  for (;;) {
    if (await condition()) return Date.now() - started;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await sleep(20);
  }
}

describe.skipIf(!testDbIsPostgres())('leader election on PostgreSQL', () => {
  let admin: pg.Client;
  /** Every test uses its own lock, so a session a test leaves behind cannot affect the next. */
  let lockId = 9_000;
  const electors: LeaderElector[] = [];

  type Replica = { elector: LeaderElector; connections: pg.Client[]; events: boolean[] };

  function replica(name: string, id: number): Replica {
    const connections: pg.Client[] = [];
    const elector = new LeaderElector({
      lockId: id,
      retryIntervalMs: 200,
      heartbeatIntervalMs: 200,
      heartbeatTimeoutMs: 1_000,
      fenceAfterMs: 2_000,
      stopGraceMs: 1_000,
      log: false,
      createConnection: () => {
        const connection = new pg.Client({
          ...readPostgresConfig({ DATABASE_URL: process.env.DATABASE_URL }),
          application_name: `leader-test-${name}`,
        });
        connections.push(connection);
        return connection;
      },
    });
    const events: boolean[] = [];
    elector.onLeadershipChange((leader) => {
      events.push(leader);
    });
    electors.push(elector);
    return { elector, connections, events };
  }

  /** The backend pid that holds lock `id`, or null. */
  async function holder(id: number): Promise<number | null> {
    const { rows } = await admin.query<{ pid: number }>(
      `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::int::oid AND objid = $2::int::oid
          AND objsubid = 2 AND granted`,
      [ADVISORY_LOCK_NAMESPACE, id]
    );
    return rows[0]?.pid ?? null;
  }

  async function pidOf(connection: pg.Client): Promise<number> {
    return (connection as unknown as { processID: number }).processID;
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
  });

  afterEach(async () => {
    await Promise.all(electors.splice(0).map((elector) => elector.stop()));
  });

  afterAll(async () => {
    await admin?.end();
  });

  it('elects exactly one of two replicas, on two connections of their own', async () => {
    const id = ++lockId;
    const a = replica('a', id);
    const b = replica('b', id);
    await Promise.all([a.elector.start(), b.elector.start()]);
    await waitFor(() => a.elector.isLeader() || b.elector.isLeader());
    for (let i = 0; i < 10; i++) {
      expect([a, b].filter((r) => r.elector.isLeader())).toHaveLength(1);
      await sleep(100);
    }
    const leader = a.elector.isLeader() ? a : b;
    expect(await holder(id)).toBe(await pidOf(leader.connections[0]));
    expect(leader.events).toEqual([true]);
  });

  it('hands over within seconds when the leader releases the lock (a rolling restart)', async () => {
    const id = ++lockId;
    const a = replica('a', id);
    await a.elector.start();
    expect(a.elector.isLeader()).toBe(true);
    const b = replica('b', id);
    await b.elector.start();
    expect(b.elector.isLeader()).toBe(false);
    const stopped = Date.now();
    await a.elector.stop();
    expect(a.events).toEqual([true, false]);
    await waitFor(() => b.elector.isLeader());
    expect(Date.now() - stopped).toBeLessThan(2_000);
    expect(await holder(id)).toBe(await pidOf(b.connections[0]));
  });

  it("takes over when the leader's session is killed, and the old leader stops at once and follows", async () => {
    const id = ++lockId;
    const a = replica('a', id);
    await a.elector.start();
    const b = replica('b', id);
    await b.elector.start();
    expect(a.elector.isLeader()).toBe(true);
    const lost = new Promise<void>((resolve) => a.elector.onLeadershipChange((leader) => { if (!leader) resolve(); }));
    await admin.query('SELECT pg_terminate_backend($1)', [await pidOf(a.connections[0])]);
    await lost;
    expect(a.elector.isLeader()).toBe(false);
    await waitFor(() => b.elector.isLeader());
    expect(await holder(id)).toBe(await pidOf(b.connections[0]));
    // The old leader competes again on a new connection, as a follower.
    await waitFor(() => a.connections.length === 2 && a.elector.status().state === 'follower');
    for (let i = 0; i < 5; i++) {
      expect([a, b].filter((r) => r.elector.isLeader())).toHaveLength(1);
      await sleep(100);
    }
  });

  it('fences a leader whose heartbeat fails: its jobs stop while it still holds the lock, then the follower takes over', async () => {
    const id = ++lockId;
    const a = replica('a', id);
    await a.elector.start();
    const b = replica('b', id);
    await b.elector.start();
    const leaderPid = await pidOf(a.connections[0]);
    const seen: Array<number | null> = [];
    a.elector.onLeadershipChange(async (leader) => {
      if (!leader) seen.push(await holder(id));
    });
    // The network to the server stalls: every query on the leader's connection hangs.
    vi.spyOn(a.connections[0], 'query').mockImplementation((() => new Promise(() => {})) as never);
    await waitFor(() => !a.elector.isLeader(), 5_000);
    expect(a.elector.status().lastError).toBe('The leader heartbeat failed or timed out');
    await waitFor(() => seen.length === 1);
    // When its jobs stopped, its session still held the lock: nobody else could lead yet.
    expect(seen).toEqual([leaderPid]);
    await waitFor(() => b.elector.isLeader());
    expect(a.elector.isLeader()).toBe(false);
  });

  it('runs the leader-only jobs on exactly one replica, and moves them with the lead', async () => {
    const id = ++lockId;
    const running = new Set<string>();
    const overlaps: string[] = [];
    function jobsOf(name: string): BackgroundJob[] {
      return [
        {
          name: 'scheduler',
          start: () => {
            if (running.size > 0) overlaps.push(`${name} started while ${[...running].join(', ')} ran`);
            running.add(name);
          },
          stop: () => {
            running.delete(name);
          },
        },
      ];
    }
    const a = replica('a', id);
    const jobsA = new LeaderOnlyJobs(jobsOf('a'), a.elector);
    jobsA.attach();
    await a.elector.start();
    expect(await jobsA.latestTerm()).toEqual(['scheduler']);
    const b = replica('b', id);
    const jobsB = new LeaderOnlyJobs(jobsOf('b'), b.elector);
    jobsB.attach();
    await b.elector.start();
    expect(jobsB.latestTerm()).toBeNull();
    expect([...running]).toEqual(['a']);

    // A rolling restart: a stops its jobs, then releases the lock.
    await a.elector.stop();
    await waitFor(() => running.has('b'));
    expect([...running]).toEqual(['b']);
    expect(jobsA.runningJobs()).toEqual([]);
    expect(jobsB.runningJobs()).toEqual(['scheduler']);

    // b's connection stalls: it fences itself (jobs stopped) before its session can let the lock go.
    await a.elector.start();
    vi.spyOn(b.connections[0], 'query').mockImplementation((() => new Promise(() => {})) as never);
    await waitFor(() => running.has('a'));
    expect([...running]).toEqual(['a']);
    expect(overlaps).toEqual([]);

    // The server ends a's session: the lock is free at once on the server, and a stops as soon as its
    // connection reports it (the window crash-only fencing cannot close; work that must never overlap
    // also takes a cluster lock).
    await waitFor(() => b.elector.status().state === 'follower');
    await admin.query('SELECT pg_terminate_backend($1)', [await pidOf(a.connections.at(-1)!)]);
    await waitFor(() => running.has('b') && !running.has('a'));
    expect(jobsA.runningJobs()).toEqual([]);
    await jobsA.close();
    await jobsB.close();
    expect(running.size).toBe(0);
  });
});
