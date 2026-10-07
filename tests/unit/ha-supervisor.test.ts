/**
 * The high availability supervisor (ee/high-availability/cluster/supervisor.ts)
 * with Redis, object storage, Litestream and the dashboard process replaced
 * by fakes: promotion with the restore step, the first start with an empty
 * bucket, a restore that fails, an empty replica,
 * Redis that lost its data or cannot be reached, the old leader coming back,
 * crash-only fencing, a lost bucket, pruning and the graceful hand-over.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Supervisor, type AppRole, type LitestreamPort, type SupervisorTiming } from '@/ee/high-availability/cluster/supervisor';
import type { HaConfig } from '@/ee/high-availability/cluster/config';
import type { LeaseRecord, LeaseStore, ReplicaPointer } from '@/ee/high-availability/cluster/lease-store';
import type { ReplicaStore } from '@/ee/high-availability/cluster/replica-store';
import type { LocalDatabase } from '@/ee/high-availability/cluster/local-db';
import type { ExitResult, ProcessHandle } from '@/ee/high-availability/cluster/litestream';
import { LitestreamError } from '@/ee/high-availability/cluster/litestream';
import { RedisUnavailableError } from '@/ee/high-availability/cluster/redis-client';
import type { NodeReport, NodeStatusFile } from '@/ee/high-availability/cluster/types';

const DB = '/app/data/ingressi.db';

const CONFIG: HaConfig = {
  nodeId: 'web-2',
  redis: {
    mode: 'standalone',
    addresses: ['valkey.example.com:6379'],
    masterName: null,
    db: 0,
    username: null,
    password: 'redis-secret',
    sentinelPassword: null,
    tls: { enabled: false, insecureSkipVerify: false },
    keyPrefix: 'ingressi-ha',
  },
  leaseTtlMs: 15_000,
  storage: {
    endpoint: 'http://minio.example.com:9000',
    apiEndpoint: 'http://minio.example.com:9000',
    region: 'us-east-1',
    bucket: 'ingressi-ha',
    path: 'ingressi',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 's3-secret',
    forcePathStyle: true,
  },
  syncIntervalSeconds: 1,
  followIntervalSeconds: 5,
  databasePath: DB,
  haDir: '/app/data/ha',
  recoverFromLocal: false,
  litestreamBin: 'litestream',
};

type FakeProcess = ProcessHandle & { label: string; signals: string[]; exit: (code: number) => void };

function fakeProcess(label: string): FakeProcess {
  let resolveExit: (result: ExitResult) => void = () => {};
  const exited = new Promise<ExitResult>((resolve) => {
    resolveExit = resolve;
  });
  const handle: FakeProcess = {
    label,
    signals: [],
    exited,
    kill(signal) {
      handle.signals.push(signal);
      resolveExit({ code: null, signal });
    },
    output: () => [],
    exit(code) {
      resolveExit({ code, signal: null });
    },
  };
  return handle;
}

/** Everything that happened, in order. */
let events: string[] = [];

class FakeStore implements LeaseStore {
  holder: LeaseRecord | null = null;
  pointer: ReplicaPointer | null = null;
  nextEpoch = 1;
  unavailable = false;
  renewResult: boolean | Error = true;
  acquireCalls: Array<{ minEpoch: number }> = [];
  released: LeaseRecord[] = [];
  reports: NodeReport[] = [];
  nodes: NodeReport[] = [];
  forgotten: string[] = [];

  private check() {
    if (this.unavailable) throw new RedisUnavailableError('connection refused');
  }
  async acquire(token: string, nodeId: string, _ttl: number, minEpoch: number) {
    this.check();
    this.acquireCalls.push({ minEpoch });
    if (this.holder) return null;
    const epoch = Math.max(this.nextEpoch, minEpoch + 1);
    this.nextEpoch = epoch + 1;
    this.holder = { token, epoch, nodeId, acquiredAt: 0, value: `${token}|${epoch}|${nodeId}|0` };
    events.push(`acquire:${epoch}`);
    return this.holder;
  }
  async renew(lease: LeaseRecord) {
    if (this.renewResult instanceof Error) throw this.renewResult;
    return this.renewResult && this.holder?.value === lease.value;
  }
  async release(lease: LeaseRecord) {
    this.released.push(lease);
    events.push('release');
    if (this.holder?.value === lease.value) this.holder = null;
    return true;
  }
  async read() {
    this.check();
    return this.holder;
  }
  async readPointer() {
    this.check();
    return this.pointer;
  }
  async writePointer(lease: LeaseRecord, pointer: ReplicaPointer) {
    if (this.holder?.value !== lease.value) return false;
    this.pointer = pointer;
    events.push(`pointer:${pointer.replicaId}`);
    return true;
  }
  async reportNode(report: NodeReport) {
    this.reports.push(report);
  }
  async listNodes() {
    return this.nodes;
  }
  async forgetNodes(ids: string[]) {
    this.forgotten.push(...ids);
  }
  close() {}
}

class FakeReplicas implements ReplicaStore {
  pointer: ReplicaPointer | null = null;
  ids: string[] = [];
  present = true;
  unavailable = false;
  written: ReplicaPointer[] = [];
  deleted: string[] = [];
  async readPointer() {
    if (this.unavailable) throw new Error('HTTP 503 from the storage');
    return this.pointer;
  }
  async writePointer(pointer: ReplicaPointer) {
    this.written.push(pointer);
    events.push(`bucket-pointer:${pointer.replicaId}`);
  }
  async listReplicaIds() {
    if (this.unavailable) throw new Error('HTTP 503 from the storage');
    return this.ids;
  }
  async hasObjects() {
    return this.present;
  }
  async deleteReplica(id: string) {
    this.deleted.push(id);
    return 3;
  }
}

class FakeLitestream implements LitestreamPort {
  restoreResult: boolean | Error = true;
  restores: string[] = [];
  replicates: FakeProcess[] = [];
  follows: FakeProcess[] = [];
  readyCopies = new Set<string>();
  synced = true;
  async restore(replicaId: string, outputPath: string) {
    this.restores.push(replicaId);
    events.push(`restore:${replicaId}->${outputPath}`);
    if (this.restoreResult instanceof Error) throw this.restoreResult;
    return this.restoreResult;
  }
  startReplicate(replicaId: string) {
    events.push(`replicate:${replicaId}`);
    const handle = fakeProcess(`replicate:${replicaId}`);
    this.replicates.push(handle);
    return handle;
  }
  startFollow(replicaId: string) {
    events.push(`follow:${replicaId}`);
    const handle = fakeProcess(`follow:${replicaId}`);
    this.follows.push(handle);
    return handle;
  }
  async lastSyncAt() {
    return this.synced && this.replicates.length > 0 ? new Date(Date.now() - 1_000) : null;
  }
  standbyCopyPath(replicaId: string) {
    return `/app/data/ha/standby-${replicaId}.db`;
  }
  standbyCopyReady(replicaId: string) {
    return this.readyCopies.has(replicaId);
  }
  removeOtherStandbyCopies() {}
}

class FakeLocal implements LocalDatabase {
  hasDatabase = true;
  exists() {
    return this.hasDatabase;
  }
  install(restored: string, live: string) {
    events.push(`install:${restored}->${live}`);
  }
  resetReplicationState() {
    events.push('reset-replication');
  }
  prepareForReplication() {
    events.push('prepare');
  }
}

class FakeApp {
  started: Array<{ role: AppRole; path: string | null; handle: FakeProcess }> = [];
  start(role: AppRole, path: string | null) {
    events.push(`app:${role}:${path ?? 'none'}`);
    const handle = fakeProcess(`app:${role}`);
    this.started.push({ role, path, handle });
    return handle;
  }
  get current() {
    return this.started.at(-1);
  }
}

let store: FakeStore;
let replicas: FakeReplicas;
let litestream: FakeLitestream;
let local: FakeLocal;
let app: FakeApp;
let statuses: NodeStatusFile[];
let exit: Mock<(code: number) => void>;

function supervisor(config: Partial<HaConfig> = {}, timing: Partial<SupervisorTiming> = {}) {
  return new Supervisor({
    config: { ...CONFIG, ...config },
    store,
    replicas,
    litestream,
    app,
    local,
    writeStatus: (status) => statuses.push(structuredClone(status)),
    exit,
    log: () => {},
    randomHex: (bytes) => 'c3'.repeat(bytes),
    timing,
  });
}

const status = () => statuses.at(-1)!;
const otherLeader = (epoch = 3): LeaseRecord => ({ token: 'f'.repeat(32), epoch, nodeId: 'web-1', acquiredAt: 0, value: `${'f'.repeat(32)}|${epoch}|web-1|0` });
const pointerTo = (replicaId: string, epoch: number): ReplicaPointer => ({ replicaId, epoch, nodeId: 'web-1', previous: null, updatedAt: '2026-10-03T09:00:00.000Z' });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-03T10:00:00.000Z'));
  events = [];
  store = new FakeStore();
  replicas = new FakeReplicas();
  litestream = new FakeLitestream();
  local = new FakeLocal();
  app = new FakeApp();
  statuses = [];
  exit = vi.fn<(code: number) => void>();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('promotion', () => {
  it('restores the newest replica, replicates to a replica of its own and points the cluster at it before serving as the leader', async () => {
    store.pointer = pointerTo('e3-aaaaaaaa', 3);
    store.nextEpoch = 4;
    const node = supervisor();
    await node.standbyTick();

    expect(node.role).toBe('leader');
    const promotion = events.slice(events.indexOf('acquire:4'));
    expect(promotion).toEqual([
      'acquire:4',
      'restore:e3-aaaaaaaa->/app/data/ha/restore.db',
      `install:/app/data/ha/restore.db->${DB}`,
      'reset-replication',
      'prepare',
      'replicate:e4-c3c3c3c3',
      'pointer:e4-c3c3c3c3',
      'bucket-pointer:e4-c3c3c3c3',
      `app:leader:${DB}`,
    ]);
    // Before taking over it was a standby with a warm copy on the way; both were stopped first.
    expect(app.started[0]).toMatchObject({ role: 'standby', path: null });
    expect(app.started[0].handle.signals).toEqual(['SIGTERM']);
    expect(litestream.follows[0].signals).toEqual(['SIGTERM']);
    expect(store.pointer).toMatchObject({ replicaId: 'e4-c3c3c3c3', epoch: 4, nodeId: 'web-2', previous: 'e3-aaaaaaaa' });

    expect(status()).toMatchObject({
      role: 'leader',
      lease: { holder: 'web-2', epoch: 4 },
      lastRestore: { ok: true, source: 'replica', replicaId: 'e3-aaaaaaaa', error: null },
    });
    expect(Date.parse(status().fenceAt!)).toBe(Date.now() + 13_000);
    // The dashboard read "leader" from the status file before it started.
    const leaderStatus = statuses.findIndex((entry) => entry.role === 'leader');
    expect(leaderStatus).toBeGreaterThanOrEqual(0);
  });

  it('sets the cluster up from its own database when the bucket is empty', async () => {
    const node = supervisor();
    await node.standbyTick();
    expect(node.role).toBe('leader');
    expect(litestream.restores).toEqual([]);
    expect(events.some((event) => event.startsWith('install:'))).toBe(false);
    expect(status().lastRestore).toMatchObject({ ok: true, source: 'bootstrap', replicaId: null });
    expect(store.pointer).toMatchObject({ replicaId: 'e1-c3c3c3c3', previous: null });
  });

  it('does not set a cluster up from nothing, gives the lease back and waits before trying again', async () => {
    local.hasDatabase = false;
    const node = supervisor();
    await node.standbyTick();

    expect(node.role).toBe('standby');
    expect(status().lastRestore).toMatchObject({ ok: false, error: expect.stringMatching(/no database to start it from/) });
    expect(store.released).toHaveLength(1);
    expect(store.holder).toBeNull();
    expect(litestream.replicates).toEqual([]);
    expect(app.started.map((started) => started.role)).toEqual(['standby', 'standby']);

    await node.standbyTick();
    expect(store.acquireCalls).toHaveLength(1);
    vi.advanceTimersByTime(5_000);
    await node.standbyTick();
    expect(store.acquireCalls).toHaveLength(2);
  });

  it('gives the lease back when the restore fails, never serving as the leader', async () => {
    store.pointer = pointerTo('e3-aaaaaaaa', 3);
    store.nextEpoch = 4;
    litestream.restoreResult = new LitestreamError('the restore failed (litestream exited with 1)');
    const node = supervisor();
    await node.standbyTick();

    expect(node.role).toBe('standby');
    expect(status().lastRestore).toMatchObject({
      ok: false,
      error: 'replica e3-aaaaaaaa could not be restored: the restore failed (litestream exited with 1)',
    });
    expect(events.some((event) => event.startsWith('install:') || event.startsWith('replicate:'))).toBe(false);
    expect(app.started.some((started) => started.role === 'leader')).toBe(false);
    expect(store.holder).toBeNull();
  });

  it('never takes an empty replica for a first start', async () => {
    store.pointer = pointerTo('e3-aaaaaaaa', 3);
    store.nextEpoch = 4;
    litestream.restoreResult = false;
    const node = supervisor();
    await node.standbyTick();
    expect(node.role).toBe('standby');
    expect(status().lastRestore?.error).toMatch(/is empty in object storage/);
  });

  it('recovers from its own database when the replica is empty and HA_RECOVER_FROM_LOCAL is set', async () => {
    store.pointer = pointerTo('e3-aaaaaaaa', 3);
    store.nextEpoch = 4;
    litestream.restoreResult = false;
    const node = supervisor({ recoverFromLocal: true });
    await node.standbyTick();
    expect(node.role).toBe('leader');
    expect(status().lastRestore).toMatchObject({ ok: true, source: 'local', replicaId: 'e3-aaaaaaaa' });
    expect(events.some((event) => event.startsWith('install:'))).toBe(false);
  });

  it('cannot decide without object storage, so it waits', async () => {
    store.pointer = pointerTo('e3-aaaaaaaa', 3);
    store.nextEpoch = 4;
    replicas.unavailable = true;
    const node = supervisor();
    await node.standbyTick();
    expect(node.role).toBe('standby');
    expect(status().lastRestore?.error).toMatch(/object storage cannot be read/);
    expect(litestream.restores).toEqual([]);
  });

  it('restores the newest replica in the bucket when Redis lost its data, above that epoch', async () => {
    replicas.ids = ['e2-11111111', 'e5-22222222'];
    const node = supervisor();
    await node.standbyTick();
    // Redis restarted its counter at 1: the node gives the lease back and takes it again above epoch 5.
    expect(node.role).toBe('standby');
    expect(litestream.restores).toEqual([]);
    await node.standbyTick();
    expect(store.acquireCalls.map((call) => call.minEpoch)).toEqual([0, 5]);
    expect(node.role).toBe('leader');
    expect(litestream.restores).toEqual(['e5-22222222']);
    expect(store.pointer).toMatchObject({ replicaId: 'e6-c3c3c3c3', epoch: 6, previous: 'e5-22222222' });
  });

  it('prefers the newer of the pointers in Redis and in the bucket', async () => {
    store.pointer = pointerTo('e3-aaaaaaaa', 3);
    replicas.pointer = pointerTo('e7-bbbbbbbb', 7);
    store.nextEpoch = 4;
    const node = supervisor();
    await node.standbyTick();
    await node.standbyTick();
    expect(litestream.restores).toEqual(['e7-bbbbbbbb']);
    expect(store.pointer?.epoch).toBe(8);
  });

  it('gives up when the first copy does not reach object storage in time', async () => {
    litestream.synced = false;
    const node = supervisor({}, { firstSyncTimeoutMs: 2_000 });
    const tick = node.standbyTick();
    await vi.advanceTimersByTimeAsync(3_000);
    await tick;
    expect(node.role).toBe('standby');
    expect(status().lastRestore?.error).toMatch(/did not reach object storage in time/);
    expect(litestream.replicates[0].signals).toEqual(['SIGTERM']);
    expect(store.pointer).toBeNull();
  });
});

describe('standby', () => {
  it('stays a standby while Redis cannot be reached', async () => {
    store.unavailable = true;
    const node = supervisor();
    await node.standbyTick();
    expect(node.role).toBe('standby');
    expect(store.acquireCalls).toEqual([]);
    expect(status()).toMatchObject({ role: 'standby', fenceAt: null, lease: { error: 'connection refused' } });
    expect(app.current).toMatchObject({ role: 'standby' });
  });

  it('follows the leader as a warm copy and serves its request-path routes from it once ready', async () => {
    store.holder = otherLeader();
    store.pointer = pointerTo('e3-aaaaaaaa', 3);
    const node = supervisor();
    await node.standbyTick();
    expect(store.acquireCalls).toEqual([]);
    expect(litestream.follows.map((follow) => follow.label)).toEqual(['follow:e3-aaaaaaaa']);
    expect(app.current).toMatchObject({ role: 'standby', path: null });

    litestream.readyCopies.add('e3-aaaaaaaa');
    await node.standbyTick();
    expect(app.started[0].handle.signals).toEqual(['SIGTERM']);
    expect(app.current).toMatchObject({ role: 'standby', path: '/app/data/ha/standby-e3-aaaaaaaa.db' });
    expect(status().follow).toEqual({ replicaId: 'e3-aaaaaaaa', ready: true, error: null });

    // A new leader writes a new replica: the old copy keeps serving until the new one is ready.
    store.pointer = pointerTo('e4-dddddddd', 4);
    await node.standbyTick();
    expect(litestream.follows[0].signals).toEqual(['SIGTERM']);
    expect(litestream.follows[1].label).toBe('follow:e4-dddddddd');
    expect(app.current).toMatchObject({ path: '/app/data/ha/standby-e3-aaaaaaaa.db' });
    expect(store.reports.at(-1)).toMatchObject({ id: 'web-2', role: 'standby' });
  });

  it('keeps no copy when the warm copy is turned off', async () => {
    store.holder = otherLeader();
    store.pointer = pointerTo('e3-aaaaaaaa', 3);
    const node = supervisor({ followIntervalSeconds: 0 });
    await node.standbyTick();
    expect(litestream.follows).toEqual([]);
    expect(status().follow).toBeNull();
  });

  it('comes back from a former leadership as a standby: its own database is never used again', async () => {
    // The former leader restarted: another node holds the lease and wrote a newer replica.
    store.holder = otherLeader(5);
    store.pointer = pointerTo('e5-eeeeeeee', 5);
    const node = supervisor({ nodeId: 'web-1' });
    await node.standbyTick();
    expect(node.role).toBe('standby');
    expect(events.some((event) => event.startsWith('install:') || event.startsWith('replicate:'))).toBe(false);

    // When the other node goes away, it restores the newest replica rather than trusting its own file.
    store.holder = null;
    store.nextEpoch = 6;
    await node.standbyTick();
    expect(litestream.restores).toEqual(['e5-eeeeeeee']);
    expect(events).toContain(`install:/app/data/ha/restore.db->${DB}`);
  });
});

async function leader(config: Partial<HaConfig> = {}, timing: Partial<SupervisorTiming> = {}) {
  store.pointer = pointerTo('e3-aaaaaaaa', 3);
  store.nextEpoch = 4;
  const node = supervisor(config, timing);
  await node.standbyTick();
  expect(node.role).toBe('leader');
  return node;
}

describe('leader', () => {
  it('fences when another node holds the lease: kills the dashboard and Litestream, then exits', async () => {
    await leader();
    const dashboard = app.current!.handle;
    const replicate = litestream.replicates[0];
    store.holder = otherLeader(9);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(exit).toHaveBeenCalledWith(1);
    expect(dashboard.signals).toContain('SIGKILL');
    expect(replicate.signals).toContain('SIGKILL');
    expect(status()).toMatchObject({ role: 'stopping', fenceAt: null });
  });

  it('fences before its lease can expire when Redis stops answering', async () => {
    await leader();
    store.renewResult = new RedisUnavailableError('connection refused');
    await vi.advanceTimersByTimeAsync(12_900);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(exit).toHaveBeenCalledWith(1);
    expect(app.current!.handle.signals).toContain('SIGKILL');
  });

  it('reports replication and the nodes, and restarts Litestream when it stops', async () => {
    const node = await leader();
    store.nodes = [
      { id: 'web-1', role: 'standby', epoch: null, follow: { replicaId: 'e4-c3c3c3c3', ready: true, error: null }, lastRestore: null, updatedAt: new Date().toISOString() },
      { id: 'web-9', role: 'standby', epoch: null, follow: null, lastRestore: null, updatedAt: '2026-10-01T00:00:00.000Z' },
    ];
    await node.leaderTick();
    expect(status().replication).toMatchObject({ replicaId: 'e4-c3c3c3c3', lagSeconds: 1, error: null });
    expect(status().nodes.map((entry) => entry.id)).toEqual(['web-1']);
    expect(store.forgotten).toEqual(['web-9']);

    litestream.replicates[0].exit(1);
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(5_000);
    await node.leaderTick();
    expect(litestream.replicates).toHaveLength(2);
    expect(litestream.replicates[1].label).toBe('replicate:e4-c3c3c3c3');
  });

  it('sends a full copy again when its replica disappears from object storage', async () => {
    const node = await leader({}, { verifyIntervalMs: 0 });
    await node.leaderTick();
    replicas.present = false;
    events = [];
    await node.leaderTick();
    expect(litestream.replicates[0].signals).toEqual(['SIGTERM']);
    expect(events).toEqual(expect.arrayContaining(['reset-replication', 'replicate:e4-c3c3c3c3', 'bucket-pointer:e4-c3c3c3c3']));
    expect(events.indexOf('reset-replication')).toBeLessThan(events.indexOf('replicate:e4-c3c3c3c3'));
  });

  it('deletes replicas of earlier terms, keeping the current one, the one it came from and newer ones', async () => {
    const node = await leader({}, { pruneDelayMs: 0 });
    replicas.ids = ['e1-11111111', 'e2-22222222', 'e3-aaaaaaaa', 'e4-c3c3c3c3', 'e9-99999999'];
    await node.leaderTick();
    expect(replicas.deleted).toEqual(['e1-11111111', 'e2-22222222']);
  });

  it('hands the lease over on shutdown after Litestream sent its last changes', async () => {
    const node = await leader();
    const dashboard = app.current!.handle;
    const replicate = litestream.replicates[0];
    events = [];
    await node.shutdown();
    expect(dashboard.signals).toEqual(['SIGTERM']);
    expect(replicate.signals).toEqual(['SIGTERM']);
    expect(events).toEqual(['release']);
    expect(store.holder).toBeNull();
    expect(store.forgotten).toEqual(['web-2']);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
