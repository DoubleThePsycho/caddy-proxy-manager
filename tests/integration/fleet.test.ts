/**
 * Fleet management (ee/fleet) end to end against mocked replicas: a master
 * and several slaves, each with its own database, SESSION_SECRET and sync
 * token, run in one process. Every request the master sends is routed to the
 * slave's real route handlers (sync key, sealed sync, status) or to a fake
 * health endpoint, so pushes are sealed, pinned and fingerprinted exactly as
 * in production. AsyncLocalStorage keeps each side on its own database while
 * the master pushes to several slaves at once.
 *
 * Covered: environment assignment and the plain sync skipping pinned
 * instances, promotion pins, canary success and failure, abort and rollback,
 * a restart in the middle of a rollout, drift states (older replicas
 * included), winding environments down, the alert evaluators and the
 * permission guards that are not the route guard's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import type { AsyncLocalStorage } from 'node:async_hooks';
import type { TestDb } from '../helpers/db';

type Store = { db: TestDb; secret: string };

const ctx = vi.hoisted(() => {
  // Every replica is reached from the same address in this process.
  process.env.INSTANCE_SYNC_RATE_MAX = '100000';
  return {
    master: null as unknown as TestDb,
    als: null as unknown as AsyncLocalStorage<Store>,
    masterSecret: 'fleet-master-session-secret-0123456789abcdef',
  };
});

vi.mock('../../src/lib/db', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const { createTestDb } = await import('../helpers/db');
  ctx.als ??= new AsyncLocalStorage<Store>();
  ctx.master ??= createTestDb();
  // The master's database, or the replica's while one of its handlers runs.
  const db = new Proxy({}, {
    get(_target, property) {
      const target = ctx.als.getStore()?.db ?? ctx.master;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return (await import('../helpers/db-module')).mockDbModule(() => db);
});
vi.mock('../../src/lib/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/config')>();
  const config = new Proxy(actual.config, {
    get(target, property) {
      if (property === 'sessionSecret') return ctx.als?.getStore()?.secret ?? ctx.masterSecret;
      if (property === 'previousSessionSecrets') return [];
      return Reflect.get(target, property);
    },
  });
  return { ...actual, config };
});
vi.mock('../../src/lib/l4-ports', () => ({
  getL4PortsDiff: async () => ({ currentPorts: [], requiredPorts: [], needsApply: false }),
  applyL4Ports: vi.fn(),
}));

import { createTestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { GET as syncGet, POST as syncPost } from '../../app/api/instances/sync/route';
import { setSetting } from '../../src/lib/settings';
import { encryptSecret } from '../../src/lib/secret';
import { buildSyncPayloadFromContent, setSlaveMasterToken, syncInstanceWithPayload, syncInstances } from '../../src/lib/instance-sync';
import { createInstance, deleteInstance } from '../../src/lib/models/instances';
import { deleteUser } from '../../src/lib/models/user';
import { APPLIED_SYNC_SETTING_KEY } from '../../src/lib/instance-sync-status';
import { recordCaddyApplyResult, resetCaddyApplyStatusForTests } from '../../src/lib/caddy-apply-status';
import { adminAccess, type Access, type Permission } from '../../src/lib/permissions';
import {
  assignInstance,
  createEnvironment,
  deleteEnvironment,
  listFleetInstances,
  updateEnvironment,
} from '../../ee/fleet/environments';
import {
  abortRollout,
  getRollout,
  previewPromotion,
  resyncInstance,
  rollbackRollout,
  runRolloutTick,
  startPromotion,
} from '../../ee/fleet/rollouts';
import { runDriftChecks } from '../../ee/fleet/drift';
import { getRevisionContent, listRevisions } from '../../ee/fleet/revisions';
import { listPinnedInstanceIds } from '../../ee/fleet/state';
import { getFleetOverview } from '../../ee/fleet/overview';
import { evaluateFleetDrift, evaluateFleetRolloutFailed } from '../../ee/alerting/evaluators';
import { first as dbFirst } from '@/src/lib/db/ops';

const DNS_TOKEN = 'cloudflare-dns-token-fleet-sentinel';
const CERT_KEY = '-----BEGIN PRIVATE KEY-----\nFLEET-KEY-SENTINEL\n-----END PRIVATE KEY-----';

type Replica = { db: TestDb; secret: string; token: string; instanceId: number };
type Behaviour = { down?: boolean; healthStatus?: number; older?: 'no-key-endpoint' | 'no-status'; rejectSync?: boolean };

let replicas: Map<string, Replica>;
let behaviour: Map<string, Behaviour>;
let requests: Array<{ host: string; method: string; path: string }>;
let adminId: number;

function access(...permissions: Permission[]): Access {
  return { userId: 99, role: 'viewer', isAdmin: false, customRole: { id: 1, name: 'ops' }, permissions: new Set(permissions), scopeTags: [] };
}
const admin = () => ({ userId: adminId, access: adminAccess(adminId) });

function asReplica<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const replica = replicas.get(host)!;
  return ctx.als.run({ db: replica.db, secret: replica.secret }, fn);
}

function now(): string {
  return new Date().toISOString();
}

/** Routes the master's requests to the replicas. */
function connectReplicas() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const host = url.host;
    requests.push({ host, method, path: url.pathname + url.search });
    const replica = replicas.get(host);
    const b = behaviour.get(host) ?? {};
    if (!replica || b.down) throw new TypeError('fetch failed');
    if (url.pathname === '/api/health') {
      return Response.json({ status: 'ok' }, { status: b.healthStatus ?? 200 });
    }
    if (url.pathname !== '/api/instances/sync') return new Response(null, { status: 404 });
    if (method === 'GET' && b.older === 'no-key-endpoint') return new Response(null, { status: 405 });
    if (method === 'POST' && b.rejectSync) return Response.json({ error: 'Failed to apply sync payload' }, { status: 500 });
    if (method === 'GET' && b.older === 'no-status') url.searchParams.delete('status');
    const body = typeof init?.body === 'string' ? init.body : null;
    const request = new NextRequest(url, { method, headers: init?.headers, body });
    return asReplica(host, () => (method === 'POST' ? syncPost(request) : syncGet(request)));
  });
}

async function addReplica(name: string): Promise<Replica> {
  const host = `${name}.example.com`;
  const replica: Replica = {
    db: createTestDb(),
    secret: `replica-${name}-session-secret-0123456789abcdef`,
    token: `fleet-sync-token-${name}-0123456789abcdef0123456789`,
    instanceId: 0,
  };
  replicas.set(host, replica);
  await asReplica(host, async () => {
    await setSetting('instance_mode', 'slave');
    await setSlaveMasterToken(replica.token);
  });
  replica.instanceId = (await createInstance({ name, baseUrl: `https://${host}`, apiToken: replica.token })).id;
  return replica;
}

/** Proxy host names stored on a replica. */
async function hostsOn(name: string): Promise<string[]> {
  const replica = replicas.get(`${name}.example.com`)!;
  return (await replica.db.select({ name: schema.proxyHosts.name }).from(schema.proxyHosts)).map((row) => row.name).sort();
}

function postsTo(name: string): number {
  return requests.filter((request) => request.host === `${name}.example.com` && request.method === 'POST').length;
}

async function addMasterHost(name: string) {
  const t = now();
  await ctx.master.insert(schema.proxyHosts).values({
    name, domains: JSON.stringify([`${name.toLowerCase()}.example.com`]), upstreams: '["backend:8080"]', createdAt: t, updatedAt: t,
  });
}

async function environmentRow(id: number) {
  return (await dbFirst(ctx.master.select().from(schema.fleetEnvironments).where(eq(schema.fleetEnvironments.id, id)).limit(1)))!;
}

async function fleetRow(instanceId: number) {
  return await dbFirst(ctx.master.select().from(schema.fleetInstances).where(eq(schema.fleetInstances.instanceId, instanceId)).limit(1));
}

/** staging (every change: r1) then production (promotion only: r2, r3). */
async function stagingAndProduction(canary: Record<string, unknown> = { enabled: false }) {
  const r1 = await addReplica('r1');
  const r2 = await addReplica('r2');
  const r3 = await addReplica('r3');
  const staging = await createEnvironment({ name: 'staging' }, adminId);
  const production = await createEnvironment({ name: 'production', promotionOnly: true, canary }, adminId);
  await assignInstance(r1.instanceId, { environmentId: staging.id }, admin());
  await assignInstance(r2.instanceId, { environmentId: production.id }, admin());
  await assignInstance(r3.instanceId, { environmentId: production.id }, admin());
  return { r1, r2, r3, staging, production };
}

beforeEach(async () => {
  ctx.master = createTestDb();
  replicas = new Map();
  behaviour = new Map();
  requests = [];
  delete process.env.INSTANCE_MODE;
  delete process.env.INSTANCE_SYNC_TOKEN;
  delete process.env.INSTANCE_SLAVES;
  await resetCaddyApplyStatusForTests();
  await setSetting('instance_mode', 'master');
  const t = now();
  adminId = (await dbFirst(ctx.master.insert(schema.users).values({
    email: 'admin@example.com', name: 'Admin', role: 'admin', status: 'active', createdAt: t, updatedAt: t,
  }).returning()))!.id;
  await ctx.master.insert(schema.certificates).values({
    name: 'Imported', type: 'imported', domainNames: '["app.example.com"]', autoRenew: false,
    certificatePem: '-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----', privateKeyPem: encryptSecret(CERT_KEY),
    createdAt: t, updatedAt: t,
  });
  await setSetting('dns_provider', { providers: { cloudflare: { api_token: encryptSecret(DNS_TOKEN) } }, default: 'cloudflare' });
  await addMasterHost('App');
  connectReplicas();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('environments and assignment', () => {
  it('keeps syncing instances without an environment, and those in an environment that receives every change', async () => {
    const r1 = await addReplica('r1');
    await addReplica('r2');
    const staging = await createEnvironment({ name: 'staging' }, adminId);
    await assignInstance(r1.instanceId, { environmentId: staging.id }, admin());

    expect(await syncInstances()).toEqual({ total: 2, success: 2, failed: 0, skippedHttp: 0 });
    expect(await hostsOn('r1')).toEqual(['App']);
    expect(await hostsOn('r2')).toEqual(['App']);
    expect(await fleetRow(r1.instanceId)).toMatchObject({ revisionId: null, driftStatus: 'in_sync' });
    expect((await fleetRow(r1.instanceId))?.pushedFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('leaves instances of a promotion-only environment out of every plain sync', async () => {
    const r1 = await addReplica('r1');
    const r2 = await addReplica('r2');
    const production = await createEnvironment({ name: 'production', promotionOnly: true }, adminId);
    await assignInstance(r2.instanceId, { environmentId: production.id }, admin());
    expect(await listPinnedInstanceIds()).toEqual(new Set([r2.instanceId]));

    expect(await syncInstances()).toEqual({ total: 1, success: 1, failed: 0, skippedHttp: 0 });
    expect(postsTo('r1')).toBe(1);
    expect(postsTo('r2')).toBe(0);
    expect(await hostsOn('r2')).toEqual([]);
    void r1;
  });

  it('does not let an INSTANCE_SLAVES entry for a pinned instance push past the promotion', async () => {
    const r1 = await addReplica('r1');
    const r2 = await addReplica('r2');
    const production = await createEnvironment({ name: 'production', promotionOnly: true }, adminId);
    await assignInstance(r2.instanceId, { environmentId: production.id }, admin());
    process.env.INSTANCE_SLAVES = JSON.stringify([
      { name: 'env-r2', url: 'https://r2.example.com/', token: r2.token },
      { name: 'env-r1', url: 'https://r1.example.com', token: r1.token },
    ]);
    try {
      expect(await syncInstances()).toMatchObject({ total: 2, success: 2 });
      expect(postsTo('r2')).toBe(0);
      expect(postsTo('r1')).toBe(2);
    } finally {
      delete process.env.INSTANCE_SLAVES;
    }
  });

  it('validates environments and refuses duplicate names', async () => {
    await createEnvironment({ name: 'staging' }, adminId);
    await expect(createEnvironment({ name: 'staging' }, adminId)).rejects.toMatchObject({ status: 409 });
    await expect(createEnvironment({ name: '' }, adminId)).rejects.toMatchObject({ status: 400 });
    await expect(createEnvironment({ name: 'x', colour: 'red' }, adminId)).rejects.toThrow(/Unknown field "colour"/);
    await expect(createEnvironment({ name: 'x', canary: { waitSeconds: 90000 } }, adminId)).rejects.toThrow(/canary.waitSeconds/);
    await expect(assignInstance(12345, { environmentId: null }, admin())).rejects.toMatchObject({ status: 404 });
  });

  it('forgets a deleted instance and the rollout pushes still waiting for it', async () => {
    const { r2, production } = await stagingAndProduction({ enabled: true, waitSeconds: 600 });
    const rollout = await startPromotion({ environmentId: production.id }, adminId);
    await deleteInstance(r2.instanceId);
    expect(await fleetRow(r2.instanceId)).toBeUndefined();
    const view = await getRollout(rollout.id);
    expect(view.targets.find((target) => target.instanceId === r2.instanceId)).toMatchObject({ status: 'skipped' });
  });
});

describe('promotion', () => {
  it('pins a promotion-only environment to a revision and promotes changes only when asked', async () => {
    const { r2, r3, production } = await stagingAndProduction();
    await syncInstances();

    const preview = await previewPromotion(production.id);
    expect(preview.source).toMatchObject({ environmentName: 'staging', revisionId: null });
    expect(preview.currentRevisionId).toBeNull();
    expect(preview.diff.entities.map((entity) => entity.entity)).toContain('proxyHosts');
    expect(JSON.stringify(preview)).not.toContain(DNS_TOKEN);
    expect(JSON.stringify(preview)).not.toContain('FLEET-KEY-SENTINEL');

    const first = await startPromotion({ environmentId: production.id }, adminId);
    expect(first).toMatchObject({ status: 'running', phase: 'rolling', fromRevisionId: null });
    await runRolloutTick();
    expect(await getRollout(first.id)).toMatchObject({ status: 'succeeded', phase: 'done' });
    expect((await environmentRow(production.id)).revisionId).toBe(first.revisionId);
    expect(await hostsOn('r2')).toEqual(['App']);
    expect((await fleetRow(r2.instanceId))?.revisionId).toBe(first.revisionId);
    expect((await fleetRow(r3.instanceId))?.revisionId).toBe(first.revisionId);

    // A change reaches staging at once and production only when promoted.
    await addMasterHost('New');
    await syncInstances();
    expect(await hostsOn('r1')).toEqual(['App', 'New']);
    expect(await hostsOn('r2')).toEqual(['App']);

    const pending = await previewPromotion(production.id);
    expect(pending.currentRevisionId).toBe(first.revisionId);
    expect(pending.diff.entities).toEqual([
      expect.objectContaining({ entity: 'proxyHosts', added: [expect.objectContaining({ label: 'New' })] }),
    ]);

    const second = await startPromotion({ environmentId: production.id }, adminId);
    expect(second.revisionId).not.toBe(first.revisionId);
    expect(second.fromRevisionId).toBe(first.revisionId);
    await runRolloutTick();
    expect(await hostsOn('r3')).toEqual(['App', 'New']);
    expect((await environmentRow(production.id)).revisionId).toBe(second.revisionId);

    // Nothing left to promote.
    await expect(startPromotion({ environmentId: production.id }, adminId)).rejects.toMatchObject({ status: 409 });
    expect((await previewPromotion(production.id)).upToDate).toBe(true);
    // The same configuration is captured once.
    expect((await listRevisions()).total).toBe(2);
  });

  it('promotes from the revision a promotion-only environment before it runs', async () => {
    const r1 = await addReplica('r1');
    const r2 = await addReplica('r2');
    const staging = await createEnvironment({ name: 'staging', promotionOnly: true, canary: { enabled: false } }, adminId);
    const production = await createEnvironment({ name: 'production', promotionOnly: true, canary: { enabled: false } }, adminId);
    await assignInstance(r1.instanceId, { environmentId: staging.id }, admin());
    await assignInstance(r2.instanceId, { environmentId: production.id }, admin());

    await expect(previewPromotion(production.id)).rejects.toThrow(/"staging" has no revision to promote yet/);
    const toStaging = await startPromotion({ environmentId: staging.id }, adminId);
    await runRolloutTick();
    await addMasterHost('Later');

    const preview = await previewPromotion(production.id);
    expect(preview.source).toMatchObject({ environmentName: 'staging', revisionId: toStaging.revisionId });
    const toProduction = await startPromotion({ environmentId: production.id }, adminId);
    expect(toProduction.revisionId).toBe(toStaging.revisionId);
    await runRolloutTick();
    expect(await hostsOn('r2')).toEqual(['App']);
  });

  it('refuses promotions into an environment that receives every change, and in slave mode', async () => {
    const staging = await createEnvironment({ name: 'staging' }, adminId);
    await expect(startPromotion({ environmentId: staging.id }, adminId)).rejects.toThrow(/promotions are for promotion-only/);
    await setSetting('instance_mode', 'slave');
    const production = await createEnvironment({ name: 'production', promotionOnly: true }, adminId);
    await expect(startPromotion({ environmentId: production.id }, adminId)).rejects.toThrow(/master mode/);
  });

  it('refuses a second rollout into the same environment while one runs', async () => {
    const { production } = await stagingAndProduction({ enabled: true, waitSeconds: 600 });
    await startPromotion({ environmentId: production.id }, adminId);
    await addMasterHost('New');
    await expect(startPromotion({ environmentId: production.id }, adminId)).rejects.toThrow(/already running/);
  });
});

describe('canary rollout', () => {
  it('syncs the canary, observes it, then continues to the rest', async () => {
    const { r2, production } = await stagingAndProduction({ enabled: true, waitSeconds: 60, checkCaddyStatus: true });
    const start = new Date();
    const rollout = await startPromotion({ environmentId: production.id }, adminId);
    expect(rollout).toMatchObject({ phase: 'canary', canary: { instanceId: r2.instanceId, waitSeconds: 60 } });

    await runRolloutTick({ now: start });
    let view = await getRollout(rollout.id);
    expect(view).toMatchObject({ status: 'running', phase: 'observing' });
    expect(view.targets.map((target) => [target.role, target.status])).toEqual([['canary', 'synced'], ['rest', 'pending']]);
    expect(await hostsOn('r2')).toEqual(['App']);
    expect(await hostsOn('r3')).toEqual([]);
    // Health and status were checked.
    expect(requests.some((request) => request.host === 'r2.example.com' && request.path === '/api/health')).toBe(true);
    expect(requests.some((request) => request.host === 'r2.example.com' && request.path.endsWith('?status=1'))).toBe(true);

    await runRolloutTick({ now: new Date(start.getTime() + 30_000) });
    expect(await getRollout(rollout.id)).toMatchObject({ phase: 'observing' });
    expect(await hostsOn('r3')).toEqual([]);

    await runRolloutTick({ now: new Date(start.getTime() + 61_000) });
    view = await getRollout(rollout.id);
    expect(view).toMatchObject({ status: 'succeeded', phase: 'done' });
    expect(view.targets.every((target) => target.status === 'synced')).toBe(true);
    expect(await hostsOn('r3')).toEqual(['App']);
    expect((await environmentRow(production.id)).revisionId).toBe(rollout.revisionId);
  });

  it('stops when the canary fails its health check and leaves the rest on the old revision', async () => {
    const { r2, r3, production } = await stagingAndProduction({ enabled: false });
    const first = await startPromotion({ environmentId: production.id }, adminId);
    await runRolloutTick();
    await addMasterHost('Broken');

    behaviour.set('r2.example.com', { healthStatus: 503 });
    const second = await startPromotion({ environmentId: production.id, canary: { waitSeconds: 60 } }, adminId);
    await runRolloutTick();

    const view = await getRollout(second.id);
    expect(view.status).toBe('failed');
    expect(view.error).toMatch(/Canary "r2" failed its health check: Health check failed with HTTP 503/);
    expect(view.targets.find((target) => target.role === 'rest')).toMatchObject({ status: 'skipped' });
    expect(await hostsOn('r2')).toEqual(['App', 'Broken']);
    expect(await hostsOn('r3')).toEqual(['App']);
    expect((await fleetRow(r3.instanceId))?.revisionId).toBe(first.revisionId);
    expect((await fleetRow(r2.instanceId))?.revisionId).toBe(second.revisionId);
    expect((await environmentRow(production.id)).revisionId).toBe(first.revisionId);

    const alerts = await evaluateFleetRolloutFailed();
    expect(alerts).toMatchObject({ status: 'ok', findings: [expect.objectContaining({ subjectKey: `rollout:${second.id}`, severity: 'critical' })] });
  });

  it('stops when the canary sync fails', async () => {
    const { production } = await stagingAndProduction({ enabled: true, waitSeconds: 0 });
    behaviour.set('r2.example.com', { rejectSync: true });
    const rollout = await startPromotion({ environmentId: production.id }, adminId);
    await runRolloutTick();
    const view = await getRollout(rollout.id);
    expect(view.status).toBe('failed');
    expect(view.error).toMatch(/canary "r2" was not synced: Sync failed with HTTP 500/);
    expect(postsTo('r3')).toBe(0);
    expect((await environmentRow(production.id)).revisionId).toBeNull();
  });

  it('stops when Caddy on the canary rejected the configuration (Caddy status check)', async () => {
    const { production } = await stagingAndProduction({ enabled: true, waitSeconds: 0, checkCaddyStatus: true });
    // The canary (r2) reports its own Caddy's last apply.
    await asReplica('r2.example.com', () => recordCaddyApplyResult({ ok: false, code: 'CADDY_REJECTED', message: 'Caddy rejected configuration' }));
    const rollout = await startPromotion({ environmentId: production.id }, adminId);
    await runRolloutTick();
    expect((await getRollout(rollout.id)).error).toMatch(/Caddy did not apply the configuration on the instance \(CADDY_REJECTED\)/);
    expect(postsTo('r3')).toBe(0);
  });

  it('fails the Caddy status check of a canary on an older release, and passes without it', async () => {
    const { production } = await stagingAndProduction({ enabled: true, waitSeconds: 0, checkCaddyStatus: true });
    behaviour.set('r2.example.com', { older: 'no-status' });
    const rollout = await startPromotion({ environmentId: production.id }, adminId);
    await runRolloutTick();
    expect((await getRollout(rollout.id)).error).toMatch(/older release that cannot report its Caddy status/);

    const again = await startPromotion({ environmentId: production.id, canary: { checkCaddyStatus: false } }, adminId);
    await runRolloutTick();
    expect(await getRollout(again.id)).toMatchObject({ status: 'succeeded' });
  });

  it('reports failed pushes in the rolling phase and keeps the environment on its revision', async () => {
    const { production } = await stagingAndProduction({ enabled: false });
    behaviour.set('r3.example.com', { down: true });
    const rollout = await startPromotion({ environmentId: production.id }, adminId);
    await runRolloutTick();
    const view = await getRollout(rollout.id);
    expect(view.status).toBe('failed');
    expect(view.error).toMatch(/Sync failed for "r3"/);
    expect(view.targets.map((target) => target.status)).toEqual(['synced', 'failed']);
    expect((await environmentRow(production.id)).revisionId).toBeNull();
  });
});

describe('abort and rollback', () => {
  it('aborts a rollout: nothing more is pushed and the environment keeps its revision', async () => {
    const { production } = await stagingAndProduction({ enabled: true, waitSeconds: 300 });
    const rollout = await startPromotion({ environmentId: production.id }, adminId);
    const start = new Date();
    await runRolloutTick({ now: start });
    const aborted = await abortRollout(rollout.id, adminId);
    expect(aborted).toMatchObject({ status: 'aborted' });
    expect(aborted.targets.find((target) => target.role === 'rest')).toMatchObject({ status: 'skipped' });
    await runRolloutTick({ now: new Date(start.getTime() + 301_000) });
    expect(postsTo('r3')).toBe(0);
    expect((await environmentRow(production.id)).revisionId).toBeNull();
    await expect(abortRollout(rollout.id, adminId)).rejects.toThrow(/not running/);
  });

  it('rolls back to the revision the environment ran before', async () => {
    const { production } = await stagingAndProduction({ enabled: false });
    const first = await startPromotion({ environmentId: production.id }, adminId);
    await runRolloutTick();
    // Nothing ran before the first rollout.
    await expect(rollbackRollout(first.id, {}, adminId)).rejects.toThrow(/nothing to roll back to/);

    await addMasterHost('Bad');
    const second = await startPromotion({ environmentId: production.id }, adminId);
    await runRolloutTick();
    expect(await hostsOn('r2')).toEqual(['App', 'Bad']);
    await expect(rollbackRollout(first.id, {}, adminId)).rejects.toThrow(/Only the latest rollout/);

    const rollback = await rollbackRollout(second.id, undefined, adminId);
    expect(rollback).toMatchObject({ kind: 'rollback', revisionId: first.revisionId, rollbackOfId: second.id, canary: { instanceId: null } });
    await runRolloutTick();
    expect(await getRollout(rollback.id)).toMatchObject({ status: 'succeeded' });
    expect(await hostsOn('r2')).toEqual(['App']);
    expect(await hostsOn('r3')).toEqual(['App']);
    expect((await environmentRow(production.id)).revisionId).toBe(first.revisionId);
  });

  it('rolls back a failed rollout, also the canary that took the new revision', async () => {
    const { production } = await stagingAndProduction({ enabled: false });
    const first = await startPromotion({ environmentId: production.id }, adminId);
    await runRolloutTick();
    await addMasterHost('Broken');
    behaviour.set('r2.example.com', { healthStatus: 500 });
    const failed = await startPromotion({ environmentId: production.id, canary: { waitSeconds: 0, checkCaddyStatus: false } }, adminId);
    await runRolloutTick();
    expect(await hostsOn('r2')).toEqual(['App', 'Broken']);

    behaviour.delete('r2.example.com');
    const rollback = await rollbackRollout(failed.id, {}, adminId);
    await expect(rollbackRollout(rollback.id, {}, adminId)).rejects.toThrow(/still running/);
    await runRolloutTick();
    expect(await hostsOn('r2')).toEqual(['App']);
    expect((await environmentRow(production.id)).revisionId).toBe(first.revisionId);
  });
});

describe('restart in the middle of a rollout', () => {
  it('picks the rollout up from the database after a restart', async () => {
    const { production } = await stagingAndProduction({ enabled: true, waitSeconds: 60 });
    const rollout = await startPromotion({ environmentId: production.id }, adminId);
    const start = new Date();
    await runRolloutTick({ now: start });
    expect(await getRollout(rollout.id)).toMatchObject({ phase: 'observing' });

    // A new process: fresh modules, only the database is left.
    vi.resetModules();
    const restarted = await import('../../ee/fleet/rollouts');
    await restarted.runRolloutTick({ now: new Date(start.getTime() + 61_000) });
    expect(await restarted.getRollout(rollout.id)).toMatchObject({ status: 'succeeded' });
    expect(await hostsOn('r3')).toEqual(['App']);
  });

  it('sends a push again that a restart cut off', async () => {
    const { r2, production } = await stagingAndProduction({ enabled: true, waitSeconds: 0 });
    const rollout = await startPromotion({ environmentId: production.id }, adminId);
    // The process stopped right after the canary push reached the replica,
    // before the rollout recorded it: its target is still pending.
    const content = await getRevisionContent(rollout.revisionId);
    const instance = (await dbFirst(ctx.master.select().from(schema.instances).where(eq(schema.instances.id, r2.instanceId)).limit(1)))!;
    expect(await syncInstanceWithPayload(instance, await buildSyncPayloadFromContent(content!), { revisionId: rollout.revisionId }))
      .toEqual({ ok: true });
    expect((await getRollout(rollout.id)).targets.find((target) => target.role === 'canary')?.status).toBe('pending');

    vi.resetModules();
    const restarted = await import('../../ee/fleet/rollouts');
    await restarted.runRolloutTick();
    expect(await restarted.getRollout(rollout.id)).toMatchObject({ status: 'succeeded' });
    expect(postsTo('r2')).toBe(2);
    expect(await hostsOn('r3')).toEqual(['App']);
  });
});

describe('drift detection', () => {
  it('reports in sync, then drifted after a change on the replica, and a re-sync puts it back', async () => {
    const r1 = await addReplica('r1');
    await syncInstances();
    let [instance] = await runDriftChecks();
    expect(instance.drift).toMatchObject({ status: 'in_sync', localChanges: false, reportedVersion: expect.any(String) });
    expect((await fleetRow(r1.instanceId))?.reportedFingerprint).toBe((await fleetRow(r1.instanceId))?.pushedFingerprint);

    await r1.db.update(schema.proxyHosts).set({ upstreams: '["evil:80"]' });
    [instance] = await runDriftChecks();
    expect(instance.drift).toMatchObject({ status: 'drifted', localChanges: true });
    expect(instance.drift.detail).toMatch(/changed since the last sync it applied/);
    expect(instance.drift.since).not.toBeNull();
    const alerts = await evaluateFleetDrift();
    expect(alerts).toMatchObject({ status: 'ok', findings: [expect.objectContaining({ subjectKey: `instance:${r1.instanceId}` })] });

    const result = await resyncInstance(r1.instanceId, adminId);
    expect(result).toMatchObject({ ok: true, revisionId: null });
    [instance] = await runDriftChecks();
    expect(instance.drift.status).toBe('in_sync');
    expect((await evaluateFleetDrift()).status === 'ok' && (await evaluateFleetDrift() as { findings: unknown[] }).findings).toEqual([]);
  });

  it('reports a replica that runs another configuration than the last push as drifted', async () => {
    const r1 = await addReplica('r1');
    await syncInstances();
    await ctx.master.update(schema.fleetInstances).set({ pushedFingerprint: 'a'.repeat(64) }).where(eq(schema.fleetInstances.instanceId, r1.instanceId));
    const [instance] = await runDriftChecks();
    expect(instance.drift).toMatchObject({ status: 'drifted', detail: expect.stringMatching(/another configuration/) });
  });

  it('reports older replicas as older version, not as failures', async () => {
    await addReplica('r1');
    await addReplica('r2');
    await syncInstances();
    behaviour.set('r1.example.com', { older: 'no-status' });
    behaviour.set('r2.example.com', { older: 'no-key-endpoint' });
    const instances = await runDriftChecks();
    expect(instances.map((instance) => instance.drift.status)).toEqual(['older_version', 'older_version']);
  });

  it('reports unreachable, unknown and upgraded replicas', async () => {
    const r1 = await addReplica('r1');
    const r2 = await addReplica('r2');
    // r2 never received anything from this master.
    await syncInstances();
    await r2.db.delete(schema.settings).where(eq(schema.settings.key, APPLIED_SYNC_SETTING_KEY));
    await ctx.master.update(schema.fleetInstances).set({ pushedFingerprint: null }).where(eq(schema.fleetInstances.instanceId, r2.instanceId));
    behaviour.set('r1.example.com', { down: true });
    let instances = await runDriftChecks();
    expect(instances.find((instance) => instance.id === r1.instanceId)?.drift).toMatchObject({ status: 'unreachable', detail: 'Status request failed' });
    expect(instances.find((instance) => instance.id === r2.instanceId)?.drift.status).toBe('unknown');

    // A replica upgraded since its last sync cannot tell local changes.
    behaviour.delete('r1.example.com');
    const record = (await dbFirst(r1.db.select().from(schema.settings).where(eq(schema.settings.key, APPLIED_SYNC_SETTING_KEY)).limit(1)))!;
    await r1.db.update(schema.settings)
      .set({ value: JSON.stringify({ ...JSON.parse(record.value), appVersion: 'older-release' }) })
      .where(eq(schema.settings.key, APPLIED_SYNC_SETTING_KEY));
    instances = await runDriftChecks();
    expect(instances.find((instance) => instance.id === r1.instanceId)?.drift).toMatchObject({ status: 'in_sync', localChanges: null });
  });

  it('re-syncs an instance of a promotion-only environment with its pinned revision', async () => {
    const { r2, production } = await stagingAndProduction();
    const rollout = await startPromotion({ environmentId: production.id }, adminId);
    await runRolloutTick();
    await addMasterHost('NotPromoted');
    await r2.db.delete(schema.proxyHosts);
    expect((await runDriftChecks()).find((instance) => instance.id === r2.instanceId)?.drift.status).toBe('drifted');

    const result = await resyncInstance(r2.instanceId, adminId);
    expect(result).toMatchObject({ ok: true, revisionId: rollout.revisionId });
    expect(await hostsOn('r2')).toEqual(['App']);
  });
});

describe('winding down', () => {
  it('finishes the running rollout, then releases, takes out and deletes', async () => {
    const { r2, production, staging } = await stagingAndProduction({ enabled: true, waitSeconds: 0 });
    const rollout = await startPromotion({ environmentId: production.id }, adminId);
    await addMasterHost('New');

    // The running rollout finishes, and plain syncs keep skipping the pinned instances.
    await runRolloutTick();
    expect(await getRollout(rollout.id)).toMatchObject({ status: 'succeeded' });
    requests.length = 0;
    await syncInstances();
    expect(postsTo('r2')).toBe(0);
    expect(postsTo('r1')).toBe(1);

    expect((await resyncInstance(r2.instanceId, adminId)).ok).toBe(true);
    await runDriftChecks();
    await assignInstance(r2.instanceId, { environmentId: null }, admin());
    const released = await updateEnvironment(production.id, { promotionOnly: false }, admin());
    expect(released).toMatchObject({ promotionOnly: false, revisionId: null });
    await deleteEnvironment(production.id, admin());
    await deleteEnvironment(staging.id, admin());
    expect(await listFleetInstances()).toHaveLength(3);
  });
});

describe('user deletion', () => {
  it('clears the user from the revisions and rollouts they caused', async () => {
    const { production } = await stagingAndProduction();
    const t = now();
    const operator = (await dbFirst(ctx.master.insert(schema.users).values({
      email: 'operator@example.com', name: 'Operator', role: 'admin', status: 'active', createdAt: t, updatedAt: t,
    }).returning()))!.id;
    const rollout = await startPromotion({ environmentId: production.id }, operator);
    expect((await listRevisions()).revisions[0]).toMatchObject({ createdBy: operator, createdByName: 'Operator' });
    expect(await getRollout(rollout.id)).toMatchObject({ startedBy: operator, startedByName: 'Operator' });

    await deleteUser(operator);
    expect((await listRevisions()).revisions[0]).toMatchObject({ createdBy: null, createdByName: null });
    expect(await getRollout(rollout.id)).toMatchObject({ startedBy: null, startedByName: null });
  });
});

describe('permission guards', () => {
  it('needs fleet:promote to release instances from a promotion-only environment', async () => {
    const { r2, staging, production } = await stagingAndProduction();
    const writer = { userId: 99, access: access('fleet:read', 'fleet:write') };
    const releaser = { userId: 99, access: access('fleet:read', 'fleet:write', 'fleet:promote') };

    await expect(updateEnvironment(production.id, { promotionOnly: false }, writer)).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/needs the fleet:promote permission/),
    });
    await expect(assignInstance(r2.instanceId, { environmentId: null }, writer)).rejects.toMatchObject({ status: 403 });
    await expect(assignInstance(r2.instanceId, { environmentId: staging.id }, writer)).rejects.toMatchObject({ status: 403 });
    await expect(deleteEnvironment(production.id, writer)).rejects.toMatchObject({ status: 403 });

    // Changes that keep instances pinned, or that touch an environment without instances, need fleet:write only.
    expect(await updateEnvironment(production.id, { name: 'prod' }, writer)).toMatchObject({ name: 'prod' });
    const empty = await createEnvironment({ name: 'dr', promotionOnly: true }, adminId);
    expect(await updateEnvironment(empty.id, { promotionOnly: false }, writer)).toMatchObject({ promotionOnly: false });

    await assignInstance(r2.instanceId, { environmentId: null }, releaser);
    expect(await listPinnedInstanceIds()).not.toContain(r2.instanceId);
  });

  it('refuses assignment changes while a rollout runs in the environment', async () => {
    const { r2, production } = await stagingAndProduction({ enabled: true, waitSeconds: 600 });
    await startPromotion({ environmentId: production.id }, adminId);
    await expect(assignInstance(r2.instanceId, { environmentId: null }, admin())).rejects.toThrow(/A rollout is running/);
    await expect(deleteEnvironment(production.id, admin())).rejects.toThrow(/A rollout is running/);
    await expect(updateEnvironment(production.id, { promotionOnly: false }, admin())).rejects.toThrow(/A rollout is running/);
    await expect(resyncInstance(r2.instanceId, adminId)).rejects.toThrow(/A rollout is running/);
  });
});

describe('overview for the Fleet page', () => {
  it('reports the master, who started each rollout and the certificate storage of each revision, without its secrets', async () => {
    const REDIS_PASSWORD = 'redis-password-fleet-sentinel';
    const { r2, production } = await stagingAndProduction({ enabled: true, waitSeconds: 600 });
    await setSetting('certificate_storage', {
      backend: 'redis',
      redis: {
        mode: 'sentinel', addresses: ['sentinel-1.example.com:26379'], masterName: 'mymaster', db: 0, keyPrefix: 'caddy',
        tls: { enabled: false, insecureSkipVerify: false }, password: encryptSecret(REDIS_PASSWORD),
      },
    });
    const rollout = await startPromotion({ environmentId: production.id }, adminId);

    const overview = await getFleetOverview();
    expect(overview.mode).toBe('master');
    expect(overview.master).toMatchObject({
      version: expect.any(String),
      certificateStorage: { backend: 'redis', redisMode: 'sentinel' },
      driftCheckIntervalSeconds: 300,
      rolloutStepSeconds: 10,
    });
    expect(overview.rollouts[0]).toMatchObject({ id: rollout.id, startedBy: adminId, startedByName: 'Admin' });
    // The running rollout's revision is listed, read from the stored revision.
    expect(overview.revisionStorage[String(rollout.revisionId)]).toEqual({ backend: 'redis', redisMode: 'sentinel' });
    expect(overview.instances.find((instance) => instance.id === r2.instanceId)).toBeDefined();
    const serialized = JSON.stringify(overview);
    expect(serialized).not.toContain('sentinel-1.example.com');
    expect(serialized).not.toContain(REDIS_PASSWORD);
    expect(serialized).not.toContain('mymaster');

    // Local storage, or none set: local.
    await setSetting('certificate_storage', { backend: 'local', redis: null });
    expect((await getFleetOverview()).master.certificateStorage).toEqual({ backend: 'local', redisMode: null });
  });
});
