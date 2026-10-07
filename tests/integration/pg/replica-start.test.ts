/**
 * startBackgroundJobs() on PostgreSQL, end to end (src/lib/background-jobs.ts):
 * the replica registers in cluster_nodes and takes the lead on its own
 * connection; when it leads at once, the jobs have started when start-up
 * returns; stopping stops them, releases the lock and records the stop; a
 * critical start-up failure is thrown on as on SQLite and leaves nothing
 * running; a new replica next to a live one joins and leads when the lead
 * is free; a follower starts its jobs once the lead is free; a second process with this node id: the newer one hands the lead
 * back, stops its jobs, answers 503 and runs again once the other stopped;
 * a process restarted after a crash leads after one heartbeat. Membership
 * runs with short intervals here (heartbeat 50 ms, retries 100 ms).
 *
 * Runs in the postgres Vitest project (TEST_DB_DIALECT=postgres).
 */
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDb, testDbIsPostgres, type TestDb } from '../../helpers/db';
import * as schema from '../../../src/lib/db/schema';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));
vi.mock('../../../src/lib/db', async () => (await import('../../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('../../../src/lib/cluster-nodes', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/lib/cluster-nodes')>();
  class FastMembership extends original.ReplicaMembership {
    constructor(identity: ConstructorParameters<typeof original.ReplicaMembership>[0], options: ConstructorParameters<typeof original.ReplicaMembership>[1]) {
      super(identity, { heartbeatIntervalMs: 50, joinRetryMs: 100, ...options });
    }
  }
  return { ...original, ReplicaMembership: FastMembership };
});

import { mayRunBackgroundJobs, startBackgroundJobs, stopBackgroundJobs, type BackgroundJob } from '../../../src/lib/background-jobs';
import { isLeader } from '../../../src/lib/db/leader';
import { ADVISORY_LOCK_NAMESPACE, LEADER_LOCK_ID } from '../../../src/lib/db/postgres';
import { replicaRefusal, setReplicaRefusal } from '@/ee/high-availability/replica-admission';
import { resetShutdownForTests, type ShutdownProcess } from '../../../src/lib/shutdown';
import { GET as health } from '../../../app/api/health/route';
import { createPgReplica } from '../../helpers/pg-test-db';
import { currentReplicaIdentity, DUPLICATE_NODE_MESSAGE, markNodeStopped, recordHeartbeat, type NodeIdentity } from '../../../src/lib/cluster-nodes';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await sleep(25);
  }
}

describe.skipIf(!testDbIsPostgres())('a PostgreSQL replica starting', () => {
  let admin: pg.Client;

  async function leaderLockHeld(): Promise<boolean> {
    const { rows } = await admin.query<{ held: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::int::oid AND objid = $2::int::oid
          AND objsubid = 2 AND granted) AS held`,
      [ADVISORY_LOCK_NAMESPACE, LEADER_LOCK_ID]
    );
    return rows[0]?.held === true;
  }

  async function row(nodeId = 'replica-test-1') {
    const rows = await ctx.db.select().from(schema.clusterNodes);
    return rows.find((candidate) => candidate.nodeId === nodeId) ?? null;
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
  });

  beforeEach(async () => {
    ctx.db = createTestDb();
    await ctx.db.$count(schema.settings);
    vi.stubEnv('INGRESSI_NODE_ID', 'replica-test-1');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await stopBackgroundJobs();
    resetShutdownForTests(null);
    setReplicaRefusal(null);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await admin?.end();
  });

  it('leads at once and starts the jobs before start-up returns; stopping stops them and hands the lead over', async () => {
    const stop = vi.fn();
    const jobs: BackgroundJob[] = [
      { name: 'start-up database tasks', critical: true, start: vi.fn() },
      { name: 'scheduler', start: vi.fn(), stop },
    ];
    expect(await startBackgroundJobs(jobs)).toEqual(['start-up database tasks', 'scheduler']);
    expect(isLeader()).toBe(true);
    expect(mayRunBackgroundJobs()).toBe(true);
    expect(await leaderLockHeld()).toBe(true);
    await waitFor(async () => (await row())?.leader === true);
    // The newest migration this version knows (drizzle-pg/meta/_journal.json).
    expect(await row()).toMatchObject({ nodeId: 'replica-test-1', stoppedAt: null, schemaVersion: expect.stringMatching(/^\d{4}_\w+$/) });

    await stopBackgroundJobs();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(isLeader()).toBe(false);
    expect(await leaderLockHeld()).toBe(false);
    expect(await row()).toMatchObject({ leader: false, stoppedAt: expect.any(String) });
  });

  // Regression: Next.js's own SIGTERM handler exited the process before the
  // replica recorded its stop, so it stayed "live" for 45 seconds.
  it('on SIGTERM, hands the lead over and records the stop before the process exits', async () => {
    const handlers = new Map<string, () => void>();
    const atExit: { row?: ReturnType<typeof row>; lockHeld?: Promise<boolean> } = {};
    const exit = vi.fn(() => {
      atExit.row = row();
      atExit.lockHeld = leaderLockHeld();
    });
    const fake = {
      env: { NEXT_MANUAL_SIG_HANDLE: 'true' },
      exit,
      once(event: string, listener: () => void) {
        handlers.set(event, listener);
        return fake;
      },
    };
    resetShutdownForTests(fake as unknown as ShutdownProcess);
    const stop = vi.fn();
    expect(await startBackgroundJobs([{ name: 'scheduler', start: vi.fn(), stop }])).toEqual(['scheduler']);
    await waitFor(async () => (await row())?.leader === true);

    handlers.get('SIGTERM')!();
    await waitFor(() => exit.mock.calls.length > 0);
    expect(exit).toHaveBeenCalledWith(143);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(await atExit.row).toMatchObject({ leader: false, stoppedAt: expect.any(String) });
    expect(await atExit.lockHeld).toBe(false);
  });

  it('throws a critical start-up failure on, as on SQLite, and leaves nothing running', async () => {
    const failure = new Error('cannot harden secrets');
    const later = vi.fn();
    await expect(
      startBackgroundJobs([
        { name: 'start-up database tasks', critical: true, start: () => Promise.reject(failure) },
        { name: 'scheduler', start: later },
      ])
    ).rejects.toBe(failure);
    expect(later).not.toHaveBeenCalled();
    expect(isLeader()).toBe(false);
    await waitFor(async () => !(await leaderLockHeld()));
  });

  it('joins next to a live replica, and leads and starts its jobs while the lead is free', async () => {
    const now = new Date().toISOString();
    await ctx.db.insert(schema.clusterNodes).values({
      nodeId: 'web-1',
      hostname: 'web-1.example.com',
      version: '1.2.3',
      schemaVersion: '0053_cluster_nodes',
      firstSeenAt: now,
      startedAt: now,
      lastHeartbeatAt: now,
    });
    const start = vi.fn();
    expect(await startBackgroundJobs([{ name: 'scheduler', start }])).toEqual(['scheduler']);
    expect(start).toHaveBeenCalledTimes(1);
    expect(replicaRefusal()).toBeNull();
    expect(isLeader()).toBe(true);
    expect(await leaderLockHeld()).toBe(true);
    expect(await row()).toMatchObject({ nodeId: 'replica-test-1', stoppedAt: null });
    const response = await health(new NextRequest('http://localhost:3000/api/health'));
    expect(response.status).toBe(200);
    // The replica already running is untouched.
    expect(await row('web-1')).toMatchObject({ lastHeartbeatAt: now, stoppedAt: null });
  });

  it('follows while another session leads, and starts its jobs once the lead is free', async () => {
    const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    try {
      await other.query('SELECT pg_advisory_lock($1::int, $2::int)', [ADVISORY_LOCK_NAMESPACE, LEADER_LOCK_ID]);
      const start = vi.fn();
      expect(await startBackgroundJobs([{ name: 'scheduler', start }])).toEqual([]);
      expect(start).not.toHaveBeenCalled();
      expect(isLeader()).toBe(false);
      expect((await row())?.leader).toBe(false);
      await other.query('SELECT pg_advisory_unlock($1::int, $2::int)', [ADVISORY_LOCK_NAMESPACE, LEADER_LOCK_ID]);
      await waitFor(() => start.mock.calls.length === 1);
      expect(isLeader()).toBe(true);
    } finally {
      await other.end();
    }
  });
  it('as the newer of two processes with one node id: hands the lead back, stops its jobs, answers 503, and runs again once the other stopped', async () => {
    const start = vi.fn();
    const stop = vi.fn();
    expect(await startBackgroundJobs([{ name: 'scheduler', start, stop }])).toEqual(['scheduler']);
    expect(isLeader()).toBe(true);
    const self = currentReplicaIdentity()!;
    // Another container with the same node id, started earlier, reaches the
    // database: it writes its heartbeat through a pool of its own.
    const other = createPgReplica();
    const older: NodeIdentity = { ...self, instanceToken: 'older-process', startedAt: new Date(Date.now() - 60_000).toISOString() };
    let beating = true;
    const heartbeats = (async () => {
      while (beating) {
        await recordHeartbeat(older, { leader: false, leaderSince: null }, { db: other.db });
        await sleep(30);
      }
    })();
    try {
      await waitFor(() => replicaRefusal() === DUPLICATE_NODE_MESSAGE);
      await waitFor(() => stop.mock.calls.length === 1);
      expect(isLeader()).toBe(false);
      await waitFor(async () => !(await leaderLockHeld()));
      expect((await health(new NextRequest('http://localhost:3000/api/health'))).status).toBe(503);
      expect((await health(new NextRequest('http://localhost:3000/api/health?scope=live'))).status).toBe(200);
      expect((await row())?.instanceToken).toBe('older-process');

      // The older process stops cleanly: this one is admitted and leads again.
      beating = false;
      await heartbeats;
      await markNodeStopped(older, { db: other.db });
      await waitFor(() => replicaRefusal() === null);
      await waitFor(() => start.mock.calls.length === 2);
      expect(isLeader()).toBe(true);
      expect((await row())?.instanceToken).toBe(self.instanceToken);
    } finally {
      beating = false;
      await heartbeats;
      await other.close();
    }
  });

  it('after a crash: takes the row over and leads once a heartbeat shows the crashed process is gone', async () => {
    const now = new Date().toISOString();
    // The previous process with this node id led and crashed a moment ago.
    await ctx.db.insert(schema.clusterNodes).values({
      nodeId: 'replica-test-1',
      hostname: 'replica-test-1.example.com',
      version: '1.2.3',
      schemaVersion: '0055_cluster_node_instance',
      firstSeenAt: now,
      startedAt: now,
      lastHeartbeatAt: now,
      leader: true,
      leaderSince: now,
      instanceToken: 'crashed-process',
    });
    const start = vi.fn();
    expect(await startBackgroundJobs([{ name: 'scheduler', start }])).toEqual([]);
    expect(start).not.toHaveBeenCalled();
    expect(await leaderLockHeld()).toBe(false);
    // It serves meanwhile: no refusal.
    expect(replicaRefusal()).toBeNull();
    await waitFor(() => start.mock.calls.length === 1);
    expect(isLeader()).toBe(true);
    expect(replicaRefusal()).toBeNull();
    expect(await row()).toMatchObject({ instanceToken: currentReplicaIdentity()!.instanceToken, stoppedAt: null });
  });
});
