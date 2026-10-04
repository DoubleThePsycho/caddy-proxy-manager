/**
 * The job leader election (src/lib/db/leader.ts) against a fake PostgreSQL
 * that keeps one advisory lock: exactly one elector leads; stop() stops the
 * jobs before it unlocks; a failed, slow or contradicted heartbeat, a
 * connection error and a stalled clock each stop the leader (its listeners
 * first, while the lock may still be held) before the connection is closed;
 * stepping down holds the replica off; connection failures back off and
 * report fixed text only. tests/integration/pg/leader-election.test.ts runs
 * the same on a real server.
 */
import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeaderElector, type LeaderElectorOptions } from '@/src/lib/db/leader';

/** One server: who holds the lock, and whether it accepts connections. */
class FakeServer {
  holder: FakeConnection | null = null;
  refuseConnections = false;
  readonly connections: FakeConnection[] = [];
}

class FakeConnection extends EventEmitter {
  ended = false;
  /** Queries never answer (a stalled network or server). */
  hang = false;
  /** The pg_locks check says the lock is gone. */
  lockVanished = false;
  readonly log: string[] = [];

  constructor(private readonly server: FakeServer) {
    super();
    server.connections.push(this);
  }

  async connect(): Promise<void> {
    if (this.server.refuseConnections) throw new Error('connect ECONNREFUSED 192.0.2.10:5432 password=secret-sentinel');
  }

  query(text: string): Promise<{ rows: Record<string, unknown>[] }> {
    this.log.push(text.split(/\s+/).slice(0, 2).join(' '));
    if (this.hang) return new Promise(() => {});
    if (this.ended) return Promise.reject(new Error('Client was closed'));
    if (text.includes('pg_try_advisory_lock')) {
      const acquired = this.server.holder === null || this.server.holder === this;
      if (acquired) this.server.holder = this;
      return Promise.resolve({ rows: [{ acquired }] });
    }
    if (text.includes('FROM pg_locks')) {
      return Promise.resolve({ rows: [{ held: this.server.holder === this && !this.lockVanished }] });
    }
    if (text.includes('pg_advisory_unlock')) {
      const released = this.server.holder === this;
      if (released) this.server.holder = null;
      return Promise.resolve({ rows: [{ released }] });
    }
    return Promise.resolve({ rows: [] });
  }

  async end(): Promise<void> {
    this.close();
  }

  /** The session ends: its lock is released. */
  close(): void {
    this.ended = true;
    if (this.server.holder === this) this.server.holder = null;
  }

  /** pg_terminate_backend: the server ends the session and the client reports it. */
  kill(): void {
    this.close();
    this.emit('error', new Error('terminating connection due to administrator command'));
    this.emit('end');
  }
}

let server: FakeServer;
const electors: LeaderElector[] = [];

function elector(options: LeaderElectorOptions = {}): { elector: LeaderElector; connections: FakeConnection[]; events: boolean[] } {
  const connections: FakeConnection[] = [];
  const instance = new LeaderElector({
    createConnection: () => {
      const connection = new FakeConnection(server);
      connections.push(connection);
      return connection as unknown as pg.Client;
    },
    retryIntervalMs: 1_000,
    heartbeatIntervalMs: 500,
    heartbeatTimeoutMs: 1_000,
    fenceAfterMs: 3_000,
    stopGraceMs: 500,
    now: () => Date.now(),
    log: false,
    ...options,
  });
  const events: boolean[] = [];
  instance.onLeadershipChange((leader) => {
    events.push(leader);
  });
  electors.push(instance);
  return { elector: instance, connections, events };
}

async function tick(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
}

async function start(...instances: LeaderElector[]) {
  const started = Promise.all(instances.map((instance) => instance.start()));
  await tick(0);
  await started;
}

const leaders = () => electors.filter((instance) => instance.isLeader()).length;

beforeEach(() => {
  vi.useFakeTimers();
  server = new FakeServer();
});

afterEach(async () => {
  const stopping = Promise.all(electors.splice(0).map((instance) => instance.stop()));
  await tick(5_000);
  await stopping;
  vi.useRealTimers();
});

describe('leader election', () => {
  it('elects exactly one of two replicas and keeps it', async () => {
    const a = elector();
    const b = elector();
    await start(a.elector, b.elector);
    expect(leaders()).toBe(1);
    const leader = a.elector.isLeader() ? a : b;
    expect(leader.events).toEqual([true]);
    for (let i = 0; i < 10; i++) {
      await tick(500);
      expect(leaders()).toBe(1);
      expect(leader.elector.isLeader()).toBe(true);
    }
    expect(leader.elector.status()).toMatchObject({ state: 'leader', leader: true, terms: 1, lastError: null });
    const follower = leader === a ? b : a;
    expect(follower.elector.status()).toMatchObject({ state: 'follower', leader: false, leaderSince: null });
  });

  it('stops the jobs before it unlocks, and hands over within the retry interval', async () => {
    const a = elector();
    await start(a.elector);
    const b = elector();
    await start(b.elector);
    expect(a.elector.isLeader()).toBe(true);
    const order: string[] = [];
    a.elector.onLeadershipChange(async (leader) => {
      if (!leader) order.push(`jobs stopped, lock held: ${server.holder === a.connections[0]}`);
    });
    const stopping = a.elector.stop();
    await tick(0);
    await stopping;
    expect(order).toEqual(['jobs stopped, lock held: true']);
    expect(a.connections[0].log).toContain('SELECT pg_advisory_unlock($1::int,');
    expect(a.connections[0].ended).toBe(true);
    expect(a.events).toEqual([true, false]);
    await tick(1_000);
    expect(b.elector.isLeader()).toBe(true);
    expect(leaders()).toBe(1);
  });

  it('fences itself when a heartbeat hangs: the jobs stop while the lock is still held, then the follower takes over', async () => {
    const a = elector();
    await start(a.elector);
    const b = elector();
    await start(b.elector);
    const states: string[] = [];
    a.elector.onLeadershipChange((leader) => {
      if (!leader) states.push(`stopped with the lock still held: ${server.holder === a.connections[0]}`);
    });
    a.connections[0].hang = true;
    await tick(500 + 1_000);
    expect(a.elector.isLeader()).toBe(false);
    expect(states).toEqual(['stopped with the lock still held: true']);
    expect(a.elector.status().lastError).toBe('The leader heartbeat failed or timed out');
    // The connection it no longer vouches for is closed, which frees the lock.
    await tick(600);
    expect(a.connections[0].ended).toBe(true);
    await tick(1_000);
    expect(b.elector.isLeader()).toBe(true);
    expect(leaders()).toBe(1);
    // It competes again, on a new connection, as a follower.
    await tick(1_000);
    expect(a.connections).toHaveLength(2);
    expect(a.elector.status().state).toBe('follower');
  });

  it('fences itself when the server says the lock is gone', async () => {
    const a = elector();
    await start(a.elector);
    a.connections[0].lockVanished = true;
    await tick(500);
    expect(a.elector.isLeader()).toBe(false);
    expect(a.events).toEqual([true, false]);
    expect(a.elector.status().lastError).toBe('The leader lock is no longer held by this replica');
  });

  it('stops leading at once when its connection is killed, and competes again', async () => {
    const a = elector();
    await start(a.elector);
    const b = elector();
    await start(b.elector);
    a.connections[0].kill();
    expect(a.elector.isLeader()).toBe(false);
    await tick(0);
    expect(a.events).toEqual([true, false]);
    await tick(1_000);
    expect(b.elector.isLeader()).toBe(true);
    await tick(1_000);
    expect(a.elector.status().state).toBe('follower');
    expect(leaders()).toBe(1);
  });

  it('is not the leader any more once no heartbeat succeeded within the fence time, before any timer runs', async () => {
    let clock = 1_000_000;
    const a = elector({ now: () => clock });
    await start(a.elector);
    expect(a.elector.isLeader()).toBe(true);
    // The process was paused: the monotonic clock moved, the timers did not run yet.
    clock += 3_000;
    expect(a.elector.isLeader()).toBe(false);
    expect(a.elector.status().leader).toBe(false);
  });

  it('steps down for a while: another replica leads, then it may compete again', async () => {
    const a = elector();
    await start(a.elector);
    const b = elector();
    await start(b.elector);
    await a.elector.stepDown('a start-up task failed', 10_000);
    expect(a.events).toEqual([true, false]);
    expect(server.holder).toBeNull();
    await tick(1_000);
    expect(b.elector.isLeader()).toBe(true);
    await b.elector.stop();
    await tick(5_000);
    expect(a.elector.isLeader()).toBe(false);
    await tick(5_000);
    expect(a.elector.isLeader()).toBe(true);
  });

  it('keeps trying to connect with a growing delay and reports fixed text only', async () => {
    server.refuseConnections = true;
    const a = elector();
    await start(a.elector);
    expect(a.elector.isLeader()).toBe(false);
    const status = a.elector.status();
    expect(status).toMatchObject({ state: 'connecting', lastError: 'Cannot connect to PostgreSQL for leader election' });
    expect(JSON.stringify(status)).not.toMatch(/secret-sentinel|192\.0\.2\.10/);
    await tick(1_000);
    expect(a.connections).toHaveLength(2);
    await tick(1_000);
    expect(a.connections).toHaveLength(2);
    await tick(1_000);
    expect(a.connections).toHaveLength(3);
    server.refuseConnections = false;
    // The lock attempt follows the connection at once (fake timers run a zero delay set during a tick 1 ms later).
    await tick(4_001);
    expect(a.elector.isLeader()).toBe(true);
    expect(a.elector.status().lastError).toBeNull();
  });

  it('competes for nothing once stopped, and releases nothing it does not hold', async () => {
    const a = elector();
    await start(a.elector);
    const b = elector();
    await start(b.elector);
    await b.elector.stop();
    expect(b.connections[0].log).not.toContain('SELECT pg_advisory_unlock($1::int,');
    expect(b.events).toEqual([]);
    await tick(5_000);
    expect(b.connections).toHaveLength(1);
    expect(a.elector.isLeader()).toBe(true);
  });
});
