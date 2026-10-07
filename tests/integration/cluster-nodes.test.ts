/**
 * Membership of PostgreSQL replicas (src/lib/cluster-nodes.ts):
 * - the first replica joins alone, a new node id joins next to live
 *   replicas and changes nothing for them;
 * - a node id that joined before starts again; stopped and silent replicas
 *   do not count as live; two new nodes joining at once both get in;
 * - heartbeats (which re-create a pruned row), the leader flag, statuses,
 *   pruning, the joined replica's log and audit, and the node id kept in the
 *   data volume;
 * - two processes with one node id (a shared data volume, a copied
 *   INGRESSI_NODE_ID): the newer refuses to run as a replica, the older runs
 *   on, and a process restarted after a crash is not taken for a duplicate;
 *   on PostgreSQL the second process has a pool of its own;
 * - countLiveReplicas, with membership's definition of live.
 * The table exists on both dialects, so this runs on both.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, testDbIsPostgres, type TestDb } from '../helpers/db';
import { createPgReplica } from '../helpers/pg-test-db';
import * as schema from '../../src/lib/db/schema';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));
vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

import {
  countLiveReplicas,
  DUPLICATE_NODE_MESSAGE,
  joinCluster,
  listClusterNodes,
  markNodeStopped,
  NODE_GONE_AFTER_MS,
  NODE_PRUNE_AFTER_MS,
  NodeIdError,
  pruneClusterNodes,
  recordHeartbeat,
  recordLeadershipTaken,
  ReplicaMembership,
  resolveNodeId,
  type NodeIdentity,
} from '@/src/lib/cluster-nodes';
import { getPostgresReplicasView } from '@/ee/high-availability/replicas';
import { replicaRefusal, setReplicaRefusal } from '@/ee/high-availability/replica-admission';
import { logAuditEvent } from '@/src/lib/audit';
import { countReplicas, EventBus } from '@/src/lib/db/events';
import type { DbExecutor } from '@/src/lib/db/types';
import { first as firstRow } from '@/src/lib/db/ops';
import { setLeaderElectorForTests, type LeaderElector } from '@/src/lib/db/leader';
import { recordLeadership } from '@/ee/high-availability/cluster/audit';

const T0 = new Date('2026-11-01T12:00:00.000Z');
/** Months later. */
const LATER = new Date('2028-01-01T12:00:00.000Z');
const seconds = (date: Date, s: number) => new Date(date.getTime() + s * 1000);

function identity(nodeId: string, overrides: Partial<NodeIdentity> = {}): NodeIdentity {
  return {
    nodeId,
    source: 'env',
    hostname: `${nodeId}.example.com`,
    version: '1.2.3',
    schemaVersion: '0053_cluster_nodes',
    startedAt: T0.toISOString(),
    instanceToken: `token-${nodeId}`,
    ...overrides,
  };
}

const join_ = (node: NodeIdentity, now: Date) => joinCluster(node, { now });

async function ids(): Promise<string[]> {
  return (await ctx.db.select({ nodeId: schema.clusterNodes.nodeId }).from(schema.clusterNodes).orderBy(schema.clusterNodes.nodeId)).map(
    (row) => row.nodeId
  );
}

beforeEach(async () => {
  ctx.db = createTestDb();
  await ctx.db.$count(schema.settings);
  setReplicaRefusal(null);
  vi.mocked(logAuditEvent).mockClear();
});

afterEach(() => {
  setReplicaRefusal(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('joining', () => {
  it('lets the first replica join', async () => {
    expect(await join_(identity('web-1'), T0)).toEqual({ admitted: true, joined: 'first' });
    const [row] = await ctx.db.select().from(schema.clusterNodes);
    expect(row).toMatchObject({
      nodeId: 'web-1',
      hostname: 'web-1.example.com',
      version: '1.2.3',
      schemaVersion: '0053_cluster_nodes',
      firstSeenAt: T0.toISOString(),
      lastHeartbeatAt: T0.toISOString(),
      stoppedAt: null,
      leader: false,
    });
  });

  it('adds a new replica next to a live one, and changes nothing for the others', async () => {
    await join_(identity('web-1'), T0);
    const before = await ctx.db.select().from(schema.clusterNodes);
    expect(await join_(identity('web-2'), seconds(T0, 5))).toEqual({ admitted: true, joined: 'added' });
    expect(await ids()).toEqual(['web-1', 'web-2']);
    expect((await ctx.db.select().from(schema.clusterNodes)).filter((row) => row.nodeId === 'web-1')).toEqual(before);
  });

  it('lets a replica that joined before start again', async () => {
    await join_(identity('web-1'), T0);
    await join_(identity('web-2'), seconds(T0, 5));
    // Months later both replicas restart (web-1 keeps its heartbeat going).
    await recordHeartbeat(identity('web-1'), { leader: true, leaderSince: LATER.toISOString() }, { now: LATER });
    expect(await join_(identity('web-2', { version: '1.2.4', startedAt: LATER.toISOString() }), seconds(LATER, 1))).toEqual({
      admitted: true,
      joined: 'returning',
    });
    expect(await join_(identity('web-1'), seconds(LATER, 2))).toEqual({ admitted: true, joined: 'returning' });
    expect(await join_(identity('web-3'), seconds(LATER, 3))).toEqual({ admitted: true, joined: 'added' });
    const web2 = (await listClusterNodes({ now: seconds(LATER, 3) })).find((node) => node.nodeId === 'web-2');
    expect(web2).toMatchObject({ version: '1.2.4', firstSeenAt: seconds(T0, 5).toISOString(), status: 'live' });
  });

  it('does not count a stopped or a silent replica as live', async () => {
    await join_(identity('web-1'), T0);
    await markNodeStopped(identity('web-1'), { now: seconds(T0, 1) });
    // A clean restart with a new id (a container without its data volume) is the only live replica.
    expect(await join_(identity('web-2'), seconds(T0, 2))).toEqual({ admitted: true, joined: 'first' });
    // web-2 crashes; once it has been silent for NODE_GONE_AFTER_MS, a new replica is alone again.
    const later = new Date(seconds(T0, 2).getTime() + NODE_GONE_AFTER_MS + 1);
    expect(await join_(identity('web-3'), later)).toEqual({ admitted: true, joined: 'first' });
    expect(await join_(identity('web-4'), seconds(later, 1))).toEqual({ admitted: true, joined: 'added' });
  });

  it('admits two new replicas that join at once', async () => {
    const outcomes = await Promise.all([join_(identity('web-1'), T0), join_(identity('web-2'), T0)]);
    expect(outcomes.every((outcome) => outcome.admitted)).toBe(true);
    expect(await ids()).toEqual(['web-1', 'web-2']);
  });
});

describe('heartbeats and the leader', () => {
  it('records heartbeats, moves the leader flag, and reports statuses', async () => {
    await join_(identity('web-1'), T0);
    await join_(identity('web-2'), seconds(T0, 1));
    await join_(identity('web-3'), seconds(T0, 2));
    await recordLeadershipTaken(identity('web-1'), T0.toISOString(), { now: seconds(T0, 3) });
    await recordLeadershipTaken(identity('web-2'), seconds(T0, 10).toISOString(), { now: seconds(T0, 10) });
    await markNodeStopped(identity('web-3'), { now: seconds(T0, 11) });
    let nodes = await listClusterNodes({ now: seconds(T0, 12) });
    expect(nodes.map(({ nodeId, status, leader, leaderSince }) => ({ nodeId, status, leader, leaderSince }))).toEqual([
      { nodeId: 'web-1', status: 'live', leader: false, leaderSince: null },
      { nodeId: 'web-2', status: 'live', leader: true, leaderSince: seconds(T0, 10).toISOString() },
      { nodeId: 'web-3', status: 'stopped', leader: false, leaderSince: null },
    ]);
    // The leader goes silent: it is gone, and no longer shown as the leader.
    nodes = await listClusterNodes({ now: new Date(seconds(T0, 10).getTime() + NODE_GONE_AFTER_MS + 1) });
    expect(nodes.find((node) => node.nodeId === 'web-2')).toMatchObject({ status: 'gone', leader: false });
  });

  it('writes a running replica back whatever happened to its row', async () => {
    await join_(identity('web-1'), T0);
    await ctx.db.delete(schema.clusterNodes).where(eq(schema.clusterNodes.nodeId, 'web-1'));
    await recordHeartbeat(identity('web-1'), { leader: false, leaderSince: null }, { now: seconds(T0, 10) });
    expect(await ids()).toEqual(['web-1']);
  });

  it('prunes replicas silent for 30 days', async () => {
    await join_(identity('web-1'), T0);
    await markNodeStopped(identity('web-1'), { now: T0 });
    await join_(identity('web-2'), seconds(T0, 1));
    const later = new Date(T0.getTime() + NODE_PRUNE_AFTER_MS + 500);
    await recordHeartbeat(identity('web-2'), { leader: true, leaderSince: later.toISOString() }, { now: later });
    expect(await pruneClusterNodes({ now: later })).toBe(1);
    expect(await ids()).toEqual(['web-2']);
  });
});

describe('this process as a replica', () => {
  it('joins next to a running replica, with a log line and an audit event', async () => {
    await join_(identity('web-1'), new Date());
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const membership = new ReplicaMembership(identity('web-2'), { isLeader: () => false, joinRetryMs: 50 });
    expect(await membership.join()).toBe('admitted');
    expect(membership.isRunning()).toBe(true);
    expect(membership.refusal()).toBeNull();
    expect(replicaRefusal()).toBeNull();
    expect(String(log.mock.calls[0]?.[0])).toContain('joined next to running replicas');
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ha_replica_joined',
        userId: null,
        summary: 'Replica web-2 joined the cluster next to running replicas',
        data: expect.objectContaining({ nodeId: 'web-2', joined: 'added' }),
      })
    );
    expect(vi.mocked(logAuditEvent).mock.calls.filter(([event]) => event.action === 'ha_replica_refused')).toHaveLength(0);
    expect(await ids()).toEqual(['web-1', 'web-2']);

    await membership.stop();
    expect((await listClusterNodes()).find((node) => node.nodeId === 'web-2')?.status).toBe('stopped');
  });

  it('heartbeats with its leader flag and shows itself in the view', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let leading = false;
    const membership = new ReplicaMembership(identity('web-1'), { isLeader: () => leading, heartbeatIntervalMs: 20 });
    expect(await membership.join()).toBe('admitted');
    membership.startHeartbeat();
    leading = true;
    await membership.leadershipChanged(true);
    let view = await getPostgresReplicasView();
    expect(view).toMatchObject({ nodeId: 'web-1', leaderNodeId: 'web-1', liveReplicas: 1, refusal: null });
    expect(view.nodes).toEqual([expect.objectContaining({ id: 'web-1', leader: true, thisNode: true, status: 'live' })]);
    leading = false;
    await membership.leadershipChanged(false);
    view = await getPostgresReplicasView();
    expect(view.leaderNodeId).toBeNull();
    await membership.stop();
    view = await getPostgresReplicasView();
    expect(view.nodes[0]).toMatchObject({ status: 'stopped', leader: false });
  });
});

describe('the takeover record', () => {
  afterEach(() => {
    setLeaderElectorForTests(null);
  });

  it('records in the audit log that a replica became the leader, on PostgreSQL only', async () => {
    let leading = true;
    setLeaderElectorForTests({ isLeader: () => leading, status: () => ({ leader: leading }) } as unknown as LeaderElector);
    new ReplicaMembership(identity('web-1'), { isLeader: () => leading });
    vi.stubEnv('DATABASE_DIALECT', 'postgres');
    vi.stubEnv('DATABASE_URL', 'postgres://ingressi@db.example.com:5432/ingressi');
    expect(await recordLeadership()).toBe(true);
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: null,
        action: 'ha_leader_started',
        summary: 'Replica web-1 became the leader of the PostgreSQL replicas and runs the background jobs',
      })
    );
    leading = false;
    expect(await recordLeadership()).toBe(false);
    vi.stubEnv('DATABASE_DIALECT', 'sqlite');
    vi.stubEnv('DATABASE_URL', ':memory:');
    leading = true;
    expect(await recordLeadership()).toBe(false);
  });
});

describe('the node id', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'node-id-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('comes from INGRESSI_NODE_ID, which must be a plain name', () => {
    expect(resolveNodeId({ INGRESSI_NODE_ID: 'web-1.eu_west', INGRESSI_DATA_DIR: dir })).toEqual({ nodeId: 'web-1.eu_west', source: 'env' });
    expect(() => resolveNodeId({ INGRESSI_NODE_ID: '../web', INGRESSI_DATA_DIR: dir })).toThrow(NodeIdError);
    expect(() => resolveNodeId({ INGRESSI_NODE_ID: 'x'.repeat(65), INGRESSI_DATA_DIR: dir })).toThrow(/INGRESSI_NODE_ID must be/);
  });

  it('is otherwise generated once and kept in the data volume', () => {
    const first = resolveNodeId({ INGRESSI_DATA_DIR: dir });
    expect(first.source).toBe('generated');
    expect(first.nodeId).toMatch(/^node-[0-9a-f]{12}$/);
    expect(readFileSync(join(dir, 'node-id'), 'utf8').trim()).toBe(first.nodeId);
    expect(resolveNodeId({ INGRESSI_DATA_DIR: dir })).toEqual({ nodeId: first.nodeId, source: 'file' });
    writeFileSync(join(dir, 'node-id'), 'not a node id!\n');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const replaced = resolveNodeId({ INGRESSI_DATA_DIR: dir });
    expect(replaced.source).toBe('generated');
    expect(replaced.nodeId).not.toBe(first.nodeId);
  });

  it.skipIf(process.getuid?.() === 0)('is generated for this start only when the data volume cannot keep it', () => {
    const readOnly = join(dir, 'ro');
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o500);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = resolveNodeId({ INGRESSI_DATA_DIR: readOnly });
    expect(result.source).toBe('ephemeral');
    expect(String(warn.mock.calls[0]?.[0])).toContain('Set INGRESSI_NODE_ID');
    chmodSync(readOnly, 0o700);
  });
});

describe('two processes with one node id', () => {
  /** web-1 as another process: started `startedAfter` seconds after T0, with its own token. */
  const process_ = (token: string, startedAfter: number) =>
    identity('web-1', { instanceToken: token, startedAt: seconds(T0, startedAfter).toISOString() });
  const beat = (node: NodeIdentity, at: Date) => recordHeartbeat(node, { leader: false, leaderSince: null }, { now: at });
  const owner = async () =>
    (await firstRow(ctx.db.select({ token: schema.clusterNodes.instanceToken }).from(schema.clusterNodes).where(eq(schema.clusterNodes.nodeId, 'web-1'))))?.token;

  it('lets a process restarted after a crash take its row over, and its next heartbeat confirms it', async () => {
    const crashed = process_('crashed', 0);
    await join_(crashed, T0);
    await beat(crashed, seconds(T0, 10));
    // The container restarts 5 seconds after the crash; the old row is still live.
    const restarted = process_('restarted', 15);
    expect(await join_(restarted, seconds(T0, 16))).toEqual({ admitted: true, joined: 'returning', contested: true });
    expect(await owner()).toBe('restarted');
    // Nobody else wrote the row meanwhile: no duplicate.
    expect(await beat(restarted, seconds(T0, 31))).toBe('recorded');
    expect(await beat(restarted, seconds(T0, 41))).toBe('recorded');
  });

  it('refuses the newer process while the older one runs; the older writes its row back and runs on', async () => {
    const older = process_('older', 0);
    const newer = process_('newer', 100);
    await join_(older, seconds(T0, 90));
    expect(await join_(newer, seconds(T0, 101))).toMatchObject({ admitted: true, contested: true });
    // The older one's heartbeat finds the newer token: it writes its own back.
    expect(await beat(older, seconds(T0, 105))).toBe('reclaimed');
    // The newer one's finds the older token: it is the duplicate, and writes nothing.
    expect(await beat(newer, seconds(T0, 110))).toBe('duplicate');
    expect(await recordLeadershipTaken(newer, seconds(T0, 111).toISOString(), { now: seconds(T0, 111) })).toBe('duplicate');
    expect(await owner()).toBe('older');
    expect((await listClusterNodes({ now: seconds(T0, 111) }))[0]).toMatchObject({ nodeId: 'web-1', leader: false, status: 'live' });
    // Stopping the duplicate does not stop the row of the process that runs.
    await markNodeStopped(newer, { now: seconds(T0, 112) });
    expect((await listClusterNodes({ now: seconds(T0, 112) }))[0]).toMatchObject({ status: 'live', stoppedAt: null });

    // Refused, it does not take the row again while the older one is live...
    expect(await joinCluster(newer, { now: seconds(T0, 130), whenContested: 'refuse' })).toEqual({
      admitted: false,
      reason: 'duplicate',
    });
    // ...and joins once it stopped.
    await markNodeStopped(older, { now: seconds(T0, 140) });
    expect(await joinCluster(newer, { now: seconds(T0, 150), whenContested: 'refuse' })).toEqual({
      admitted: true,
      joined: 'returning',
    });
    expect(await owner()).toBe('newer');
  });

  it('decides by the start time whichever joined first, and breaks a tie by the token, the same way on both sides', async () => {
    const older = process_('b-older', 0);
    const newer = process_('a-newer', 50);
    await join_(newer, seconds(T0, 51));
    // The older process reaches the database later (it was slow to start).
    expect(await join_(older, seconds(T0, 60))).toMatchObject({ contested: true });
    expect(await beat(newer, seconds(T0, 61))).toBe('duplicate');
    expect(await beat(older, seconds(T0, 70))).toBe('recorded');

    const left = process_('token-a', 200);
    const right = process_('token-b', 200);
    await join_(left, seconds(T0, 201));
    await join_(right, seconds(T0, 202));
    expect(await beat(left, seconds(T0, 203))).toBe('reclaimed');
    expect(await beat(right, seconds(T0, 204))).toBe('duplicate');
  });

  it('takes over a row written before tokens existed, or by a process gone silent, without a contest', async () => {
    await ctx.db.insert(schema.clusterNodes).values({
      nodeId: 'web-1',
      hostname: 'web-1.example.com',
      version: '1.2.2',
      schemaVersion: '0054_shared_runtime_state',
      firstSeenAt: T0.toISOString(),
      startedAt: T0.toISOString(),
      lastHeartbeatAt: T0.toISOString(),
    });
    expect(await join_(process_('upgraded', 5), seconds(T0, 6))).toEqual({ admitted: true, joined: 'returning' });
    const later = new Date(seconds(T0, 6).getTime() + NODE_GONE_AFTER_MS + 1);
    expect(await join_(process_('after-silence', 100), later)).toEqual({ admitted: true, joined: 'returning' });
  });

  describe('as replicas', () => {
    let second: { db: DbExecutor; close(): Promise<void> } | null = null;

    afterEach(async () => {
      await second?.close();
      second = null;
    });

    /** The second process's database: a pool of its own on PostgreSQL. */
    function secondDb(): DbExecutor {
      if (!testDbIsPostgres()) return ctx.db;
      const replica = createPgReplica();
      second = { db: replica.db, close: replica.close };
      return replica.db;
    }

    const now = () => new Date();
    const live = (token: string, startedAt: Date) => identity('web-1', { instanceToken: token, startedAt: startedAt.toISOString() });

    it('refuses the newer process (503 message, log, audit), keeps the older one running, and admits the newer once the older stopped', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const older = new ReplicaMembership(live('older', new Date(Date.now() - 60_000)), { isLeader: () => false, heartbeatIntervalMs: 20 });
      expect(await older.join()).toBe('admitted');
      older.startHeartbeat();
      const admitted = vi.fn();
      // It confirms after 1.5 of its heartbeat intervals: the older one beats several times meanwhile.
      const newer = new ReplicaMembership(live('newer', now()), {
        isLeader: () => false,
        heartbeatIntervalMs: 60,
        joinRetryMs: 40,
        onAdmitted: admitted,
        db: secondDb(),
      });
      // It took the row over and waits for a heartbeat before it runs anything.
      expect(await newer.join()).toBe('pending');
      expect(replicaRefusal()).toBeNull();
      newer.retryUntilAdmitted();
      await vi.waitFor(() => expect(newer.refusal()).toBe('duplicate'), { timeout: 5_000 });
      expect(replicaRefusal()).toBe(DUPLICATE_NODE_MESSAGE);
      expect(error.mock.calls.some(([line]) => String(line).includes('another process is already running with its node id') && String(line).includes('web-1'))).toBe(true);
      expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ha_replica_refused', data: expect.objectContaining({ nodeId: 'web-1', reason: 'duplicate' }) })
      );
      expect(older.isRunning()).toBe(true);
      expect(await owner()).toBe('older');
      expect(admitted).not.toHaveBeenCalled();
      // The 503 names no node id.
      expect(DUPLICATE_NODE_MESSAGE).not.toContain('web-1');

      // The older process stops: the newer one joins at its next attempt.
      await older.stop();
      await vi.waitFor(() => expect(admitted).toHaveBeenCalledTimes(1), { timeout: 5_000 });
      expect(newer.refusal()).toBeNull();
      expect(newer.isRunning()).toBe(true);
      expect(replicaRefusal()).toBeNull();
      expect(await owner()).toBe('newer');
      await newer.stop();
    });

    it('stops a running replica that turns out to be the newer one, and confirms a process restarted after a crash', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      // The newer process runs first, alone.
      const refused = vi.fn();
      const newer = new ReplicaMembership(live('newer', now()), { isLeader: () => true, heartbeatIntervalMs: 20, joinRetryMs: 60_000, onRefused: refused });
      expect(await newer.join()).toBe('admitted');
      newer.startHeartbeat();
      await newer.leadershipChanged(true);
      // An older process with the same id reaches the database: it takes the row and confirms.
      const admitted = vi.fn();
      const older = new ReplicaMembership(live('older', new Date(Date.now() - 60_000)), {
        isLeader: () => false,
        heartbeatIntervalMs: 20,
        onAdmitted: admitted,
        db: secondDb(),
      });
      expect(await older.join()).toBe('pending');
      older.retryUntilAdmitted();
      // The running newer one stops leading and competing.
      await vi.waitFor(() => expect(refused).toHaveBeenCalledTimes(1), { timeout: 5_000 });
      expect(newer.refusal()).toBe('duplicate');
      expect(newer.isRunning()).toBe(false);
      await vi.waitFor(() => expect(admitted).toHaveBeenCalledTimes(1), { timeout: 5_000 });
      expect(await owner()).toBe('older');
      expect((await listClusterNodes()).find((node) => node.nodeId === 'web-1')).toMatchObject({ leader: false, status: 'live' });
      await newer.stop();
      await older.stop();
      expect((await listClusterNodes()).find((node) => node.nodeId === 'web-1')?.status).toBe('stopped');

      // A crash: the process wrote its row, then nothing more. Its replacement is admitted after one heartbeat.
      const restarted = vi.fn();
      const replacement = new ReplicaMembership(live('replacement', now()), { isLeader: () => false, heartbeatIntervalMs: 20, onAdmitted: restarted });
      await recordHeartbeat(live('crashed', new Date(Date.now() - 1_000)), { leader: true, leaderSince: new Date().toISOString() });
      expect(await replacement.join()).toBe('pending');
      replacement.retryUntilAdmitted();
      await vi.waitFor(() => expect(restarted).toHaveBeenCalledTimes(1), { timeout: 5_000 });
      expect(replacement.refusal()).toBeNull();
      expect(await owner()).toBe('replacement');
      await replacement.stop();
    });
  });
});

describe('counting the replicas', () => {
  beforeEach(() => {
    // Not started as a replica (earlier tests constructed memberships).
    (globalThis as { __ingressiReplicaIdentity?: unknown }).__ingressiReplicaIdentity = undefined;
  });

  it('counts the live ones, and this process while it is not one of them', async () => {
    expect(await countLiveReplicas({ now: T0 })).toBe(1);
    await join_(identity('web-1'), T0);
    await join_(identity('web-2'), seconds(T0, 1));
    await join_(identity('web-3'), seconds(T0, 2));
    await markNodeStopped(identity('web-3'), { now: seconds(T0, 3) });
    await recordHeartbeat(identity('web-1'), { leader: false, leaderSince: null }, { now: seconds(T0, 40) });
    // web-1 and web-2 are live; this process has not joined.
    expect(await countLiveReplicas({ now: seconds(T0, 4) })).toBe(3);
    // This process is web-1.
    new ReplicaMembership(identity('web-1'), { isLeader: () => false });
    expect(await countLiveReplicas({ now: seconds(T0, 4) })).toBe(2);
    // web-2 goes silent.
    expect(await countLiveReplicas({ now: new Date(seconds(T0, 1).getTime() + NODE_GONE_AFTER_MS + 1) })).toBe(1);
  });

  it('is what countReplicas answers on PostgreSQL, and 1 on SQLite', async () => {
    await join_(identity('web-1', { startedAt: new Date().toISOString() }), new Date());
    new ReplicaMembership(identity('web-9'), { isLeader: () => false });
    expect(await countReplicas(new EventBus({ mode: 'postgres' }))).toBe(2);
    expect(await countReplicas(new EventBus({ mode: 'local' }))).toBe(1);
  });
});
