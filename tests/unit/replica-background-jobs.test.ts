/**
 * PostgreSQL replicas in the core gates:
 * - LeaderOnlyJobs (src/lib/background-jobs.ts): the jobs start in order
 *   when the replica becomes the leader and stop (in reverse) as soon as it
 *   stops; a job whose start outlived the lead is stopped at once; a critical
 *   failure stops the term and gives the lead up for a while, longer each
 *   time; the next term starts them again;
 * - mayRunBackgroundJobs() follows the election on PostgreSQL;
 * - the health check's scopes on a replica (`leader`: 200 on the leader
 *   only), and a refused replica (503 everywhere but `live`);
 * - proxy.ts answers everything but the health check with 503 on a refused
 *   replica.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  CRITICAL_FAILURE_HOLD_OFF_MS,
  LeaderOnlyJobs,
  mayRunBackgroundJobs,
  type BackgroundJob,
  type Leadership,
} from '@/src/lib/background-jobs';
import { setLeaderElectorForTests, type LeaderElector, type LeadershipListener } from '@/src/lib/db/leader';
import { setReplicaRefusal } from '@/ee/high-availability/replica-admission';
import { GET as health } from '@/app/api/health/route';
import middleware from '@/proxy';

class FakeLeadership implements Leadership {
  leader = false;
  readonly listeners = new Set<LeadershipListener>();
  readonly stepDowns: Array<[string, number]> = [];

  isLeader(): boolean {
    return this.leader;
  }

  onLeadershipChange(listener: LeadershipListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Changes the lead without waiting for the listeners (as the elector starts the jobs). */
  set(leader: boolean): Promise<void> {
    this.leader = leader;
    return Promise.all([...this.listeners].map(async (listener) => listener(leader))).then(() => undefined);
  }

  async stepDown(reason: string, holdOffMs: number): Promise<void> {
    this.stepDowns.push([reason, holdOffMs]);
    if (this.leader) await this.set(false);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let log: string[];

function job(name: string, options: Partial<BackgroundJob> & { stoppable?: boolean } = {}): BackgroundJob {
  const { stoppable = true, ...rest } = options;
  return {
    name,
    start: () => {
      log.push(`start ${name}`);
    },
    ...(stoppable ? { stop: () => void log.push(`stop ${name}`) } : {}),
    ...rest,
  };
}

beforeEach(() => {
  log = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setLeaderElectorForTests(null);
  setReplicaRefusal(null);
});

describe('leader-only jobs', () => {
  it('start in order when the replica leads and stop in reverse as soon as it stops; one-off work has nothing to stop', async () => {
    const leadership = new FakeLeadership();
    const jobs = new LeaderOnlyJobs([job('start-up', { stoppable: false }), job('scheduler'), job('parser')], leadership);
    jobs.attach();
    expect(jobs.latestTerm()).toBeNull();
    await leadership.set(true);
    expect(await jobs.latestTerm()).toEqual(['start-up', 'scheduler', 'parser']);
    expect(jobs.runningJobs()).toEqual(['start-up', 'scheduler', 'parser']);
    await leadership.set(false);
    expect(log).toEqual(['start start-up', 'start scheduler', 'start parser', 'stop parser', 'stop scheduler']);
    expect(jobs.runningJobs()).toEqual([]);

    // The next term starts every job again.
    log = [];
    await leadership.set(true);
    await jobs.latestTerm();
    expect(log).toEqual(['start start-up', 'start scheduler', 'start parser']);
    await jobs.close();
    expect(log.slice(3)).toEqual(['stop parser', 'stop scheduler']);
    await leadership.set(true);
    expect(log).toHaveLength(5);
  });

  it('skips jobs marked skipInTests under NODE_ENV=test, as on SQLite', async () => {
    const leadership = new FakeLeadership();
    const jobs = new LeaderOnlyJobs([job('a'), job('mailer', { skipInTests: true })], leadership);
    jobs.attach();
    await leadership.set(true);
    expect(await jobs.latestTerm()).toEqual(['a']);
  });

  it('stops a job whose start outlived the lead, and starts none after it', async () => {
    const leadership = new FakeLeadership();
    const slow = deferred();
    const jobs = new LeaderOnlyJobs(
      [job('first'), job('slow', { start: async () => { log.push('start slow'); await slow.promise; } }), job('last')],
      leadership
    );
    jobs.attach();
    void leadership.set(true);
    const term = jobs.latestTerm()!;
    await vi.waitFor(() => expect(log).toContain('start slow'));
    await leadership.set(false);
    expect(log).toEqual(['start first', 'start slow', 'stop first']);
    slow.resolve();
    expect(await term).toEqual(['first']);
    expect(log).toEqual(['start first', 'start slow', 'stop first', 'stop slow']);
    expect(jobs.runningJobs()).toEqual([]);
  });

  it('logs a job that fails to start and starts the others', async () => {
    const leadership = new FakeLeadership();
    const jobs = new LeaderOnlyJobs([job('broken', { start: () => { throw new Error('no ClickHouse'); } }), job('scheduler')], leadership);
    jobs.attach();
    await leadership.set(true);
    expect(await jobs.latestTerm()).toEqual(['scheduler']);
    expect(leadership.stepDowns).toEqual([]);
  });

  it('gives the lead up when a critical job fails, longer each time, and starts afresh on the next term', async () => {
    const leadership = new FakeLeadership();
    let failures = 2;
    const failure = new Error('cannot harden secrets');
    const jobs = new LeaderOnlyJobs(
      [job('before'), job('start-up', { critical: true, start: () => { if (failures-- > 0) throw failure; log.push('start start-up'); } }), job('after')],
      leadership
    );
    jobs.attach();
    void leadership.set(true);
    await expect(jobs.latestTerm()).rejects.toBe(failure);
    await vi.waitFor(() => expect(leadership.stepDowns).toHaveLength(1));
    expect(leadership.stepDowns[0]).toEqual(['start-up failed', CRITICAL_FAILURE_HOLD_OFF_MS]);
    expect(log).toEqual(['start before', 'stop before']);
    expect(leadership.isLeader()).toBe(false);

    void leadership.set(true);
    await expect(jobs.latestTerm()).rejects.toBe(failure);
    await vi.waitFor(() => expect(leadership.stepDowns).toHaveLength(2));
    expect(leadership.stepDowns[1][1]).toBe(2 * CRITICAL_FAILURE_HOLD_OFF_MS);

    log = [];
    void leadership.set(true);
    expect(await jobs.latestTerm()).toEqual(['before', 'start-up', 'after']);
    expect(log).toEqual(['start before', 'start start-up', 'start after']);
  });
});

describe('on PostgreSQL', () => {
  let leading = false;

  beforeEach(() => {
    vi.stubEnv('DATABASE_DIALECT', 'postgres');
    vi.stubEnv('DATABASE_URL', 'postgres://ingressi@db.example.com:5432/ingressi');
    leading = false;
  });

  function useElector() {
    setLeaderElectorForTests({ isLeader: () => leading } as unknown as LeaderElector);
  }

  it('runs the background jobs only on the leader', () => {
    expect(mayRunBackgroundJobs()).toBe(false);
    useElector();
    expect(mayRunBackgroundJobs()).toBe(false);
    leading = true;
    expect(mayRunBackgroundJobs()).toBe(true);
  });

  async function check(scope?: string) {
    const response = await health(new NextRequest(`http://localhost:3000/api/health${scope ? `?scope=${scope}` : ''}`));
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  }

  it('answers the health check on every replica, and scope=leader on the leader only', async () => {
    useElector();
    expect(await check()).toEqual({ status: 200, body: { status: 'ok' }, cache: 'no-store' });
    expect((await check('request-path')).status).toBe(200);
    expect((await check('live')).status).toBe(200);
    expect(await check('leader')).toEqual({ status: 503, body: { status: 'follower', role: 'follower' }, cache: 'no-store' });
    leading = true;
    expect(await check('leader')).toEqual({ status: 200, body: { status: 'ok', role: 'leader' }, cache: 'no-store' });
  });

  it('takes a refused replica out of every scope but live', async () => {
    useElector();
    setReplicaRefusal('This replica was not admitted: example reason');
    for (const scope of [undefined, 'request-path', 'leader']) {
      expect(await check(scope)).toMatchObject({ status: 503, body: { status: 'refused', role: 'refused' } });
    }
    expect((await check('live')).status).toBe(200);
  });

  it('answers the leader scope on SQLite too: a standalone dashboard runs the jobs', async () => {
    vi.stubEnv('DATABASE_DIALECT', 'sqlite');
    vi.stubEnv('DATABASE_URL', ':memory:');
    expect((await check('leader')).status).toBe(200);
  });
});

describe('proxy on a refused replica', () => {
  async function through(path: string) {
    return middleware(new NextRequest(`http://localhost:3000${path}`));
  }

  it('answers everything but the health check with 503 and the reason', async () => {
    setReplicaRefusal('This replica was not admitted: example reason');
    const api = await through('/api/v1/proxy-hosts');
    expect(api.status).toBe(503);
    expect(api.headers.get('x-ha-role')).toBe('refused');
    expect(api.headers.get('cache-control')).toBe('no-store');
    expect(await api.json()).toEqual({ error: 'This replica was not admitted: example reason', role: 'refused' });
    for (const path of ['/', '/settings', '/login', '/api/forward-auth/verify', '/api/monetization/gate', '/portal']) {
      expect((await through(path)).status, path).toBe(503);
    }
    const page = await through('/');
    expect(page.headers.get('content-type')).toContain('text/plain');
    const healthCheck = await through('/api/health');
    expect(healthCheck.status).not.toBe(503);
    expect(healthCheck.headers.get('x-middleware-next')).toBe('1');

    setReplicaRefusal(null);
    expect((await through('/api/v1/proxy-hosts')).status).not.toBe(503);
  });
});
