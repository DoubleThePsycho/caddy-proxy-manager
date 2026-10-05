/**
 * Pull replicas (ee/fleet/pull-*.ts) end to end: a master, pull replicas and
 * a pushed replica, each with its own database and SESSION_SECRET, run in
 * one process. A pull replica runs the real agent (pull-agent.ts) with its
 * environment set while it runs; its requests reach the master's real route
 * handler, and the pushed replica's reach the real sync route, so keys are
 * proved, pinned and sealed exactly as in production. AsyncLocalStorage
 * keeps each side on its own database.
 *
 * Covered: registration (credential shown once, hash stored), proof of the
 * key and pinning on first contact, conditional pulls, apply and report,
 * replay of a reply, a stolen credential, another replica's credential, a
 * disabled replica, rotation and revocation, rollouts with a pull canary
 * (success, failure, timeout, abort, restart), drift from reports, the
 * license gate, permissions and the REST routes.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AsyncLocalStorage } from 'node:async_hooks';
import type { TestDb } from '../helpers/db';
import type { Access, Permission } from '../../src/lib/permissions';

type Store = { db: TestDb; secret: string; previous?: string[] };

const ctx = vi.hoisted(() => {
  // Every replica is reached from, and polls from, the same address in this process.
  process.env.INSTANCE_SYNC_RATE_MAX = '100000';
  process.env.INSTANCE_PULL_RATE_MAX = '100000';
  process.env.INSTANCE_PULL_REPLICA_RATE_MAX = '100000';
  return {
    master: null as unknown as TestDb,
    als: null as unknown as AsyncLocalStorage<Store>,
    masterSecret: 'pull-master-session-secret-0123456789abcdef',
    access: null as unknown as Access,
  };
});

vi.mock('../../src/lib/db', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const { createTestDb } = await import('../helpers/db');
  ctx.als ??= new AsyncLocalStorage<Store>();
  ctx.master ??= createTestDb();
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
      if (property === 'previousSessionSecrets') return ctx.als?.getStore()?.previous ?? [];
      if (property === 'baseUrl') return 'https://master.example.com';
      return Reflect.get(target, property);
    },
  });
  return { ...actual, config };
});
vi.mock('../../src/lib/l4-ports', () => ({
  getL4PortsDiff: async () => ({ currentPorts: [], requiredPorts: [], needsApply: false }),
  applyL4Ports: vi.fn(),
}));
vi.mock('../../src/lib/auth', () => ({
  auth: vi.fn(),
  checkSameOrigin: vi.fn(() => null),
  requireAdmin: vi.fn(),
  requirePermission: vi.fn(async () => ({ user: { id: String(ctx.access.userId), role: 'admin' }, access: ctx.access })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../../src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-auth')>();
  const permissions = await import('../../src/lib/permissions');
  return {
    ...actual,
    requireApiPermission: vi.fn(async (_request: unknown, permission: Permission) => {
      if (!permissions.can(ctx.access, permission)) throw new actual.ApiAuthError(`Permission required: ${permission}`, 403);
      return { userId: ctx.access.userId, role: 'admin', authMethod: 'bearer', access: ctx.access };
    }),
  };
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { POST as pullPost } from '../../app/api/instances/pull/route';
import InstancesPage from '../../app/(dashboard)/instances/page';
import InstancesClient from '../../app/(dashboard)/instances/InstancesClient';
import { GET as syncGet, POST as syncPost } from '../../app/api/instances/sync/route';
import { GET as listRoute, POST as createRoute } from '../../app/api/v1/fleet/pull-replicas/route';
import { DELETE as deleteRoute, GET as getRoute } from '../../app/api/v1/fleet/pull-replicas/[id]/route';
import { DELETE as revokeRoute, POST as rotateRoute } from '../../app/api/v1/fleet/pull-replicas/[id]/credential/route';
import { setSetting } from '../../src/lib/settings';
import { encryptSecret, decryptSecret, isEncryptedSecret } from '../../src/lib/secret';
import { setSlaveMasterToken, syncInstances } from '../../src/lib/instance-sync';
import { SYNC_KEY_CHANGED_ERROR } from '../../src/lib/instance-sync-error';
import { getSyncKeyPin } from '../../src/lib/instance-sync-key-pins';
import { createInstance, deleteInstance, updateInstance } from '../../src/lib/models/instances';
import { applyReceivedSyncPayload } from '../../src/lib/instance-sync-apply';
import { createSyncKeyResponse, getSyncPublicKey } from '../../src/lib/sync-crypto';
import { resetCaddyApplyStatusForTests } from '../../src/lib/caddy-apply-status';
import { applyCaddyConfig } from '../../src/lib/caddy';
import { logAuditEvent } from '../../src/lib/audit';
import { adminAccess, isAdminLevel, UNSCOPED_ONLY_PERMISSIONS } from '../../src/lib/permissions';
import { setTrustedLicenseKeysForTests } from '../../ee/licensing/public-keys';
import { installLicense, licenseSigner } from '../helpers/config-fixture';
import { assignInstance, createEnvironment } from '../../ee/fleet/environments';
import { abortRollout, getRollout, resyncInstance, rollbackRollout, runRolloutTick, startPromotion } from '../../ee/fleet/rollouts';
import { runDriftChecks } from '../../ee/fleet/drift';
import { getFleetOverview } from '../../ee/fleet/overview';
import {
  createPullReplica,
  deletePullReplica,
  getPullReplica,
  listPullReplicas,
  revokePullCredential,
  rotatePullCredential,
} from '../../ee/fleet/pull-replicas';
import { resetPullChallengesForTests, resetPullPayloadsForTests } from '../../ee/fleet/pull-server';
import { pullOnce, resetPullAgentForTests, runPullRound, type ReadyPullConfig } from '../../ee/fleet/pull-agent';
import { first as dbFirst } from '@/src/lib/db/ops';

const MASTER = 'master.example.com';
const DNS_TOKEN = 'cloudflare-dns-token-pull-sentinel';
const CERT_KEY = '-----BEGIN PRIVATE KEY-----\nPULL-KEY-SENTINEL\n-----END PRIVATE KEY-----';

type Replica = { name: string; db: TestDb; secret: string; credential: string; instanceId: number; previous?: string[] };
type PushReplica = { db: TestDb; secret: string; token: string; instanceId: number };
type Exchange = { credential: string; status: number; body: Record<string, unknown> };

let pushReplicas: Map<string, PushReplica>;
let exchanges: Exchange[];
let replayNext: Record<string, unknown> | null;
let masterBehaviour: 'down' | 'redirect' | 'huge' | null;
let pollInits: RequestInit[];
let adminId: number;

function access(...permissions: Permission[]): Access {
  return { userId: 99, role: 'viewer', isAdmin: false, customRole: { id: 1, name: 'ops' }, permissions: new Set(permissions), scopeTags: [] };
}

function now(): string {
  return new Date().toISOString();
}

/** Run `fn` as the replica: its database, its SESSION_SECRET and its pull environment. */
async function asReplica<T>(replica: Pick<Replica, 'db' | 'secret' | 'credential' | 'previous'>, fn: () => Promise<T>): Promise<T> {
  const saved = { mode: process.env.INSTANCE_SYNC_MODE, url: process.env.INSTANCE_MASTER_URL, token: process.env.INSTANCE_PULL_TOKEN };
  process.env.INSTANCE_SYNC_MODE = 'pull';
  process.env.INSTANCE_MASTER_URL = `https://${MASTER}`;
  process.env.INSTANCE_PULL_TOKEN = replica.credential;
  try {
    return await ctx.als.run({ db: replica.db, secret: replica.secret, previous: replica.previous }, fn);
  } finally {
    for (const [key, value] of [['INSTANCE_SYNC_MODE', saved.mode], ['INSTANCE_MASTER_URL', saved.url], ['INSTANCE_PULL_TOKEN', saved.token]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function headerOf(init: RequestInit | undefined, name: string): string {
  return new Headers(init?.headers).get(name) ?? '';
}

/** Routes the replicas' polls to the master and the master's pushes to the pushed replicas. */
function connect() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : null;
    if (url.host === MASTER && url.pathname === '/api/instances/pull') {
      const credential = headerOf(init, 'authorization').replace(/^Bearer /, '');
      pollInits.push(init ?? {});
      if (masterBehaviour === 'down') throw new TypeError('fetch failed');
      if (masterBehaviour === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.com/' } });
      if (masterBehaviour === 'huge') {
        return new Response('{"version":1}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(64 * 1024 * 1024) } });
      }
      if (replayNext) {
        const replayed = replayNext;
        replayNext = null;
        return Response.json(replayed);
      }
      const headers = new Headers(init?.headers);
      headers.set('x-forwarded-for', '203.0.113.7');
      const request = new NextRequest(url, { method, headers, body });
      const response = await ctx.als.run({ db: ctx.master, secret: ctx.masterSecret }, () => pullPost(request));
      exchanges.push({ credential, status: response.status, body: await response.clone().json() });
      return response;
    }
    const pushed = pushReplicas.get(url.host);
    if (!pushed) throw new TypeError('fetch failed');
    if (url.pathname === '/api/health') return Response.json({ status: 'ok' });
    if (url.pathname !== '/api/instances/sync') return new Response(null, { status: 404 });
    const request = new NextRequest(url, { method, headers: init?.headers, body });
    return ctx.als.run({ db: pushed.db, secret: pushed.secret }, () => (method === 'POST' ? syncPost(request) : syncGet(request)));
  });
}

async function addReplica(name: string, input: Record<string, unknown> = {}): Promise<Replica> {
  const issued = await createPullReplica({ name, ...input }, adminId);
  const replica: Replica = {
    name,
    db: createTestDb(),
    secret: `pull-replica-${name}-session-secret-0123456789abcdef`,
    credential: issued.credential,
    instanceId: issued.replica.id,
  };
  await asReplica(replica, () => setSetting('instance_mode', 'slave'));
  return replica;
}

async function addPushReplica(name: string): Promise<PushReplica> {
  const host = `${name}.example.com`;
  const replica: PushReplica = {
    db: createTestDb(),
    secret: `push-replica-${name}-session-secret-0123456789abcdef`,
    token: `fleet-sync-token-${name}-0123456789abcdef0123456789`,
    instanceId: 0,
  };
  pushReplicas.set(host, replica);
  await ctx.als.run({ db: replica.db, secret: replica.secret }, async () => {
    await setSetting('instance_mode', 'slave');
    await setSlaveMasterToken(replica.token);
  });
  replica.instanceId = (await createInstance({ name, baseUrl: `https://${host}`, apiToken: replica.token })).id;
  return replica;
}

function configOf(replica: Replica): ReadyPullConfig {
  return { mode: 'pull', ok: true, masterUrl: `https://${MASTER}`, credential: replica.credential, intervalSeconds: 30 };
}

/** One round of the replica's agent: a poll and the polls that follow at once. */
async function round(replica: Replica): Promise<Exchange[]> {
  // The master shares a payload between polls a few seconds apart; the tests change the configuration in between.
  resetPullPayloadsForTests();
  const before = exchanges.length;
  await asReplica(replica, () => runPullRound());
  return exchanges.slice(before).filter((exchange) => exchange.credential === replica.credential);
}

async function hostsOn(replica: { db: TestDb }): Promise<string[]> {
  return (await replica.db.select({ name: schema.proxyHosts.name }).from(schema.proxyHosts)).map((row) => row.name).sort();
}

async function addMasterHost(name: string) {
  const t = now();
  await ctx.master.insert(schema.proxyHosts).values({
    name, domains: JSON.stringify([`${name.toLowerCase()}.example.com`]), upstreams: '["backend:8080"]', createdAt: t, updatedAt: t,
  });
}

async function fleetRow(instanceId: number) {
  return await dbFirst(ctx.master.select().from(schema.fleetInstances).where(eq(schema.fleetInstances.instanceId, instanceId)).limit(1));
}

async function pullRow(instanceId: number) {
  return await dbFirst(ctx.master.select().from(schema.fleetPullReplicas).where(eq(schema.fleetPullReplicas.instanceId, instanceId)).limit(1));
}

async function instanceRow(instanceId: number) {
  return (await dbFirst(ctx.master.select().from(schema.instances).where(eq(schema.instances.id, instanceId)).limit(1)))!;
}

async function environmentRow(id: number) {
  return (await dbFirst(ctx.master.select().from(schema.fleetEnvironments).where(eq(schema.fleetEnvironments.id, id)).limit(1)))!;
}

async function removeLicense() {
  await ctx.master.delete(schema.settings).where(eq(schema.settings.key, 'license'));
}

function auditActions(): string[] {
  return vi.mocked(logAuditEvent).mock.calls.map(([event]) => (event as { action: string }).action);
}

const admin = () => ({ userId: adminId, access: adminAccess(adminId) });

/** production (promotion only) with pull replicas p1 (the canary) and p2. */
async function production(canary: Record<string, unknown>) {
  const p1 = await addReplica('p1');
  const p2 = await addReplica('p2');
  const env = await createEnvironment({ name: 'production', promotionOnly: true, canary }, adminId);
  await assignInstance(p1.instanceId, { environmentId: env.id }, admin());
  await assignInstance(p2.instanceId, { environmentId: env.id }, admin());
  return { p1, p2, env };
}

beforeEach(async () => {
  ctx.master = createTestDb();
  pushReplicas = new Map();
  exchanges = [];
  replayNext = null;
  masterBehaviour = null;
  pollInits = [];
  delete process.env.INSTANCE_MODE;
  delete process.env.INSTANCE_SYNC_MODE;
  delete process.env.INSTANCE_PULL_APPLY_TIMEOUT;
  await resetCaddyApplyStatusForTests();
  resetPullAgentForTests();
  await resetPullChallengesForTests();
  resetPullPayloadsForTests();
  vi.mocked(logAuditEvent).mockClear();
  vi.mocked(applyCaddyConfig).mockReset();
  vi.mocked(applyCaddyConfig).mockResolvedValue(undefined as never);
  setTrustedLicenseKeysForTests(licenseSigner.keys);
  await installLicense(ctx.master, 'enterprise');
  await setSetting('instance_mode', 'master');
  const t = now();
  adminId = (await dbFirst(ctx.master.insert(schema.users).values({
    email: 'admin@example.com', name: 'Admin', role: 'admin', status: 'active', createdAt: t, updatedAt: t,
  }).returning()))!.id;
  ctx.access = adminAccess(adminId);
  await ctx.master.insert(schema.certificates).values({
    name: 'Imported', type: 'imported', domainNames: '["app.example.com"]', autoRenew: false,
    certificatePem: '-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----', privateKeyPem: encryptSecret(CERT_KEY),
    createdAt: t, updatedAt: t,
  });
  await setSetting('dns_provider', { providers: { cloudflare: { api_token: encryptSecret(DNS_TOKEN) } }, default: 'cloudflare' });
  await addMasterHost('App');
  connect();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => setTrustedLicenseKeysForTests(null));

describe('registration', () => {
  it('issues a credential once, stores only its hash and gives the replica its environment', async () => {
    const issued = await createPullReplica({ name: 'edge' }, adminId);
    expect(issued.credential).toMatch(/^pull_[A-Za-z0-9_-]{43}$/);
    expect(issued.env).toContain('INSTANCE_MODE=slave');
    expect(issued.env).toContain('INSTANCE_SYNC_MODE=pull');
    expect(issued.env).toContain('INSTANCE_MASTER_URL=https://master.example.com');
    expect(issued.env).toContain(`INSTANCE_PULL_TOKEN=${issued.credential}`);

    const row = (await pullRow(issued.replica.id))!;
    expect(row.credentialHash).toBe(createHash('sha256').update(issued.credential).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(issued.credential);
    expect(isEncryptedSecret(row.fingerprintToken!)).toBe(true);
    const instance = await instanceRow(issued.replica.id);
    expect(instance).toMatchObject({ syncMode: 'pull', apiToken: '', enabled: true });
    expect(instance.baseUrl).toMatch(/^pull:[0-9a-f-]{36}$/);

    const listed = await listPullReplicas();
    expect(listed).toEqual([expect.objectContaining({ name: 'edge', hasCredential: true, credentialPrefix: issued.credential.slice(0, 11), checkIn: 'never' })]);
    expect(JSON.stringify(await getFleetOverview())).not.toContain(issued.credential);
    expect(auditActions()).toContain('fleet_pull_replica_created');

    // Nothing is pushed to a pull replica.
    expect(await syncInstances()).toEqual({ total: 0, success: 0, failed: 0, skippedHttp: 0 });
    await expect(updateInstance(issued.replica.id, { baseUrl: 'https://edge.example.com' })).rejects.toMatchObject({ status: 400 });
  });

  it('validates the input and leaves nothing behind for a key that cannot be pinned', async () => {
    await expect(createPullReplica({ name: '' }, adminId)).rejects.toMatchObject({ status: 400 });
    await expect(createPullReplica({ name: 'x', url: 'https://x.example.com' }, adminId)).rejects.toThrow(/Unknown field "url"/);
    await expect(createPullReplica({ name: 'x', syncPublicKey: 'not-a-key' }, adminId)).rejects.toMatchObject({ status: 400 });
    expect(await listPullReplicas()).toEqual([]);
    expect(await ctx.master.select().from(schema.fleetPullReplicas)).toEqual([]);
  });
});

describe('first contact', () => {
  it('proves and pins the key, then sends the configuration sealed to it and records the report', async () => {
    const replica = await addReplica('edge');
    const polls = await round(replica);
    // No challenge yet: 401 with one; then the configuration; then the report.
    expect(polls.map((poll) => [poll.status, poll.body.changed])).toEqual([[401, undefined], [200, true], [200, false]]);
    const sent = JSON.stringify(polls[1].body.payload);
    expect(sent).toContain('sealed:v1:');
    expect(sent).not.toContain(DNS_TOKEN);
    expect(sent).not.toContain('PULL-KEY-SENTINEL');

    expect(await hostsOn(replica)).toEqual(['App']);
    const ownKey = await asReplica(replica, async () => getSyncPublicKey());
    const pin = await getSyncKeyPin((await instanceRow(replica.instanceId)).baseUrl);
    expect(pin).toMatchObject({ keyId: ownKey.keyId, source: 'first-use' });
    expect(auditActions()).toContain('instance_sync_key_pinned');

    // The replica stored the secrets under its own key.
    const dns = (await dbFirst(replica.db.select().from(schema.settings).where(eq(schema.settings.key, 'synced:dns_provider')).limit(1)))!;
    const token = JSON.parse(dns.value).providers.cloudflare.api_token as string;
    expect(await asReplica(replica, async () => decryptSecret(token))).toBe(DNS_TOKEN);
    const certificate = (await dbFirst(replica.db.select().from(schema.certificates).limit(1)))!;
    expect(await asReplica(replica, async () => decryptSecret(certificate.privateKeyPem!))).toBe(CERT_KEY);

    // The report counts as a push: drift and rollouts read it.
    expect(await fleetRow(replica.instanceId)).toMatchObject({ revisionId: null, driftStatus: 'in_sync' });
    expect((await fleetRow(replica.instanceId))?.pushedFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await instanceRow(replica.instanceId)).toMatchObject({ lastSyncError: null });
    expect((await instanceRow(replica.instanceId)).lastSyncAt).not.toBeNull();
    expect(await getPullReplica(replica.instanceId)).toMatchObject({
      checkIn: 'ok', lastSeenAddress: '203.0.113.7', pollIntervalSeconds: 30, syncKeyPin: { keyId: ownKey.keyId },
    });
  });

  it('refuses a key other than the one an admin pinned when adding the replica', async () => {
    const other = await asReplica({ db: createTestDb(), secret: 'some-other-session-secret-0123456789abcdef', credential: '' }, async () =>
      getSyncPublicKey().publicKey.toString('base64'));
    const replica = await addReplica('edge', { syncPublicKey: other });
    const polls = await round(replica);
    expect(polls.some((poll) => poll.body.changed === true)).toBe(false);
    expect(polls.at(-1)?.status).toBe(409);
    expect(await hostsOn(replica)).toEqual([]);
    expect((await instanceRow(replica.instanceId)).lastSyncError).toBe(SYNC_KEY_CHANGED_ERROR);
  });
});

describe('key rotation on the replica', () => {
  it('re-pins a key the replica proves with the pinned one, as a push does, and refuses one it cannot prove', async () => {
    const replica = await addReplica('edge');
    await round(replica);
    const identity = (await instanceRow(replica.instanceId)).baseUrl;
    const oldPin = await getSyncKeyPin(identity);

    // SESSION_SECRET rotated the documented way: the old one in SESSION_SECRET_PREVIOUS.
    const rotated: Replica = { ...replica, secret: 'pull-replica-edge-rotated-secret-0123456789abcdef', previous: [replica.secret] };
    const polls = await round(rotated);
    expect(polls.at(-1)?.status).toBe(200);
    const newPin = await getSyncKeyPin(identity);
    expect(newPin).toMatchObject({ source: 'rotation' });
    expect(newPin?.keyId).not.toBe(oldPin?.keyId);
    expect(auditActions()).toContain('instance_sync_key_rotated');

    // Rotated again without the previous secret: nothing proves the new key.
    const unproved: Replica = { ...replica, secret: 'pull-replica-edge-third-secret-0123456789abcdef0', previous: [] };
    expect((await round(unproved)).at(-1)?.status).toBe(409);
    expect(await getSyncKeyPin(identity)).toEqual(newPin);
  });
});

describe('conditional pulls', () => {
  it('answers no change while the replica runs what it should, and sends a change once', async () => {
    const replica = await addReplica('edge');
    await round(replica);
    let polls = await round(replica);
    expect(polls.map((poll) => [poll.status, poll.body.changed])).toEqual([[200, false]]);
    expect(polls[0].body.payload).toBeUndefined();

    await addMasterHost('New');
    polls = await round(replica);
    expect(polls.map((poll) => [poll.status, poll.body.changed])).toEqual([[200, true], [200, false]]);
    expect(await hostsOn(replica)).toEqual(['App', 'New']);
  });

  it('keeps pull replicas of a promotion-only environment on what they have until a promotion', async () => {
    const { p1 } = await production({ enabled: false });
    const polls = await round(p1);
    expect(polls.map((poll) => poll.body.changed)).toEqual([undefined, false]);
    expect(await hostsOn(p1)).toEqual([]);
  });
});

describe('replay, stolen and borrowed credentials', () => {
  it('refuses a replayed reply: it is sealed for another poll', async () => {
    const replica = await addReplica('edge');
    const first = await round(replica);
    const recorded = first.find((poll) => poll.body.changed === true)!.body;
    await addMasterHost('New');
    await round(replica);
    expect(await hostsOn(replica)).toEqual(['App', 'New']);

    replayNext = recorded;
    const outcome = await asReplica(replica, () => pullOnce(configOf(replica)));
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringMatching(/not sealed for this poll/) });
    expect(await hostsOn(replica)).toEqual(['App', 'New']);
    // Applied directly, its nonce is unknown to the replica.
    expect(await asReplica(replica, () => applyReceivedSyncPayload(recorded.payload as never))).toMatchObject({ ok: false, status: 409 });
    expect(await hostsOn(replica)).toEqual(['App', 'New']);
  });

  it('gives a stolen credential nothing without the pinned private key', async () => {
    const replica = await addReplica('edge');
    await round(replica);
    const seen = (await pullRow(replica.instanceId))?.lastSeenAt;
    const thief: Replica = { ...replica, db: createTestDb(), secret: 'thief-session-secret-0123456789abcdef0123' };
    await asReplica(thief, () => setSetting('instance_mode', 'slave'));
    const polls = await round(thief);
    expect(polls.every((poll) => poll.body.changed === undefined)).toBe(true);
    expect(polls.at(-1)?.status).toBe(409);
    expect(await hostsOn(thief)).toEqual([]);

    // Presenting the replica's public key without its private key: no proof, no configuration.
    const stolenKey = await asReplica(replica, async () => createSyncKeyResponse(null));
    const send = async (body: Record<string, unknown>) => {
      const response = await fetch(`https://${MASTER}/api/instances/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${replica.credential}` },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const status = { version: 1, appVersion: '1.0.0', fingerprint: null, appliedAt: null, localChanges: null, overriddenSettings: [], lastSync: { at: null, error: null }, caddy: null };
    const base = { version: 1, key: stolenKey, pollIntervalSeconds: 30, status, health: { status: 'ok' } };
    const first = await send({ ...base, challenge: null });
    expect(first.status).toBe(401);
    const withoutProof = await send({ ...base, challenge: first.body.challenge });
    expect(withoutProof.status).toBe(401);
    const forged = await send({
      ...base,
      challenge: withoutProof.body.challenge,
      key: { ...stolenKey, rotationProofs: [{ keyId: stolenKey.keyId, proof: 'A'.repeat(43) }] },
    });
    expect(forged.status).toBe(401);
    expect([first, withoutProof, forged].some((reply) => 'payload' in reply.body)).toBe(false);
    // Nor are its check-ins and reports recorded.
    expect((await pullRow(replica.instanceId))?.lastSeenAt).toBe(seen);
  });

  it("lets a credential act only for its own replica", async () => {
    const a = await addReplica('a');
    const b = await addReplica('b');
    await round(a);
    // b set up with a's credential presents b's key, which is not a's pin.
    const borrowed: Replica = { ...b, credential: a.credential };
    const polls = await round(borrowed);
    expect(polls.at(-1)?.status).toBe(409);
    expect(await hostsOn(b)).toEqual([]);
    // b's own credential works.
    await round(b);
    expect(await hostsOn(b)).toEqual(['App']);

    await deleteInstance(a.instanceId);
    expect((await round(a)).at(-1)?.status).toBe(401);
  });
});

describe('credential lifecycle', () => {
  it('rotates and revokes credentials; the key pin stays', async () => {
    const replica = await addReplica('edge');
    await round(replica);
    const pinned = await getSyncKeyPin((await instanceRow(replica.instanceId)).baseUrl);

    const rotated = await rotatePullCredential(replica.instanceId, adminId);
    expect(rotated.credential).not.toBe(replica.credential);
    expect((await round(replica)).map((poll) => poll.status)).toEqual([401]);
    expect(await asReplica(replica, async () => (await import('../../ee/fleet/pull-agent')).getPullAgentStatus().lastError))
      .toMatch(/refused the pull credential/);

    const renewed: Replica = { ...replica, credential: rotated.credential };
    const polls = await round(renewed);
    // The fingerprints are keyed with the credential: the configuration is sent once more.
    expect(polls.map((poll) => poll.body.changed)).toEqual([undefined, true, false]);
    expect(await getSyncKeyPin((await instanceRow(replica.instanceId)).baseUrl)).toEqual(pinned);

    const revoked = await revokePullCredential(replica.instanceId, adminId);
    expect(revoked).toMatchObject({ hasCredential: false, credentialPrefix: null });
    expect((await round(renewed)).map((poll) => poll.status)).toEqual([401]);
    expect(auditActions()).toEqual(expect.arrayContaining(['fleet_pull_credential_rotated', 'fleet_pull_credential_revoked']));

    const again = await rotatePullCredential(replica.instanceId, adminId);
    expect((await round({ ...replica, credential: again.credential })).at(-1)?.status).toBe(200);
  });

  it('refuses a disabled replica with a clear message', async () => {
    const replica = await addReplica('edge');
    await updateInstance(replica.instanceId, { enabled: false });
    const polls = await round(replica);
    expect(polls).toEqual([expect.objectContaining({ status: 403, body: { error: 'This pull replica is disabled on the master' } })]);
    expect(await hostsOn(replica)).toEqual([]);
    await updateInstance(replica.instanceId, { enabled: true });
    await round(replica);
    expect(await hostsOn(replica)).toEqual(['App']);
  });

  it('makes the replica refuse pushes', async () => {
    const replica = await addReplica('edge');
    const response = await asReplica(replica, () =>
      syncPost(new NextRequest('https://edge.example.com/api/instances/sync', { method: 'POST', headers: { authorization: 'Bearer x' }, body: '{}' })));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/accepts no pushes/);
  });
});

describe('rollouts with pull replicas', () => {
  it('completes when the pull canary and the rest report the revision, also with a pushed replica in the environment', async () => {
    const { p1, p2, env } = await production({ enabled: true, waitSeconds: 60, checkCaddyStatus: true });
    const r3 = await addPushReplica('r3');
    await assignInstance(r3.instanceId, { environmentId: env.id }, admin());
    const start = new Date();
    const rollout = await startPromotion({ environmentId: env.id, canary: { instanceId: p1.instanceId } }, adminId);

    await runRolloutTick({ now: start });
    let view = await getRollout(rollout.id);
    expect(view).toMatchObject({ status: 'running', phase: 'canary' });
    expect(await hostsOn(p1)).toEqual([]);

    await round(p1);
    expect(await hostsOn(p1)).toEqual(['App']);
    expect((await fleetRow(p1.instanceId))?.revisionId).toBe(rollout.revisionId);
    await round(p2);
    expect(await hostsOn(p2)).toEqual([]);

    await runRolloutTick({ now: new Date(start.getTime() + 1000) });
    view = await getRollout(rollout.id);
    expect(view.phase).toBe('observing');
    expect(view.targets.find((target) => target.role === 'canary')?.status).toBe('synced');

    await runRolloutTick({ now: new Date(start.getTime() + 61_000) });
    view = await getRollout(rollout.id);
    expect(view).toMatchObject({ status: 'running', phase: 'rolling' });
    expect(await hostsOn(r3)).toEqual(['App']);
    expect(view.targets.find((target) => target.instanceId === p2.instanceId)?.status).toBe('pending');

    await round(p2);
    await runRolloutTick({ now: new Date(start.getTime() + 62_000) });
    view = await getRollout(rollout.id);
    expect(view).toMatchObject({ status: 'succeeded' });
    expect(view.targets.every((target) => target.status === 'synced')).toBe(true);
    expect(await hostsOn(p2)).toEqual(['App']);
    expect((await environmentRow(env.id)).revisionId).toBe(rollout.revisionId);

    const drift = await runDriftChecks();
    expect(drift.filter((instance) => instance.syncMode === 'pull').map((instance) => instance.drift.status)).toEqual(['in_sync', 'in_sync']);
  });

  it('fails when the canary cannot apply the revision, and leaves the rest where they were', async () => {
    const { p1, p2, env } = await production({ enabled: true, waitSeconds: 0 });
    const rollout = await startPromotion({ environmentId: env.id }, adminId);
    await runRolloutTick();
    vi.mocked(applyCaddyConfig).mockRejectedValue(new Error('Caddy rejected configuration'));
    await round(p1);
    // The next poll reports the failure.
    await round(p1);
    expect((await instanceRow(p1.instanceId)).lastSyncError).toBe('Failed to apply synchronized configuration');
    await runRolloutTick();

    const view = await getRollout(rollout.id);
    expect(view.status).toBe('failed');
    expect(view.error).toMatch(/canary "p1" was not synced: The pull replica could not apply the revision/);
    expect(view.targets.find((target) => target.role === 'rest')).toMatchObject({ status: 'skipped' });
    expect((await environmentRow(env.id)).revisionId).toBeNull();
    await round(p2);
    expect(await hostsOn(p2)).toEqual([]);
  });

  it('fails when the canary does not take the revision in time', async () => {
    const { p1, env } = await production({ enabled: true, waitSeconds: 0 });
    const rollout = await startPromotion({ environmentId: env.id }, adminId);
    await runRolloutTick();
    await runRolloutTick({ now: new Date(Date.now() + 5 * 60_000) });
    expect(await getRollout(rollout.id)).toMatchObject({ status: 'running' });

    await runRolloutTick({ now: new Date(Date.now() + 11 * 60_000) });
    const view = await getRollout(rollout.id);
    expect(view.status).toBe('failed');
    expect(view.error).toMatch(/did not fetch the revision within 600 s/);
    // Nothing is pending for it any more: it keeps what it has.
    await round(p1);
    expect(await hostsOn(p1)).toEqual([]);
  });

  it('aborts: a replica asked but not confirmed keeps its revision; a rollback puts the canary back', async () => {
    const { p1, p2, env } = await production({ enabled: false });
    const first = await startPromotion({ environmentId: env.id }, adminId);
    await runRolloutTick();
    await round(p1);
    await round(p2);
    await runRolloutTick();
    expect(await getRollout(first.id)).toMatchObject({ status: 'succeeded' });

    await addMasterHost('New');
    const second = await startPromotion({ environmentId: env.id, canary: { instanceId: p2.instanceId, waitSeconds: 300 } }, adminId);
    await runRolloutTick();
    await round(p2);
    expect(await hostsOn(p2)).toEqual(['App', 'New']);
    await runRolloutTick();
    expect(await getRollout(second.id)).toMatchObject({ phase: 'observing' });
    await abortRollout(second.id, adminId);
    await round(p1);
    expect(await hostsOn(p1)).toEqual(['App']);
    // The canary keeps what it took, as a pushed canary would.
    await round(p2);
    expect(await hostsOn(p2)).toEqual(['App', 'New']);

    const rollback = await rollbackRollout(second.id, {}, adminId);
    await runRolloutTick();
    await round(p1);
    await round(p2);
    await runRolloutTick();
    expect(await getRollout(rollback.id)).toMatchObject({ status: 'succeeded' });
    expect(await hostsOn(p2)).toEqual(['App']);
    expect((await environmentRow(env.id)).revisionId).toBe(first.revisionId);
  });

  it('picks a pull rollout up after a restart of the master', async () => {
    const { p1, p2, env } = await production({ enabled: true, waitSeconds: 0 });
    const rollout = await startPromotion({ environmentId: env.id }, adminId);
    await runRolloutTick();

    // A new master process: fresh modules and no challenges, only the database is left.
    vi.resetModules();
    await resetPullChallengesForTests();
    const restarted = await import('../../ee/fleet/rollouts');
    await round(p1);
    await restarted.runRolloutTick();
    await round(p2);
    await restarted.runRolloutTick();
    expect(await restarted.getRollout(rollout.id)).toMatchObject({ status: 'succeeded' });
    expect(await hostsOn(p2)).toEqual(['App']);
  });
});

describe('drift from reports', () => {
  it('is unknown before the first check-in, then follows the reports, and missed polls are unreachable', async () => {
    const replica = await addReplica('edge');
    let [instance] = await runDriftChecks();
    expect(instance.drift).toMatchObject({ status: 'unknown', detail: 'The pull replica has not checked in yet' });

    await round(replica);
    [instance] = await runDriftChecks();
    expect(instance.drift).toMatchObject({ status: 'in_sync', localChanges: false });
    expect(instance.pull).toMatchObject({ checkIn: 'ok', hasCredential: true });

    await replica.db.update(schema.proxyHosts).set({ upstreams: '["evil:80"]' });
    await round(replica);
    [instance] = await runDriftChecks();
    expect(instance.drift).toMatchObject({ status: 'drifted', localChanges: true });

    // A re-sync is sent with the next poll and repairs it.
    expect(await resyncInstance(replica.instanceId, adminId)).toMatchObject({ ok: true, pending: true, revisionId: null });
    const polls = await round(replica);
    expect(polls.map((poll) => poll.body.changed)).toEqual([true, false]);
    expect((await dbFirst(replica.db.select().from(schema.proxyHosts).limit(1)))?.upstreams).toBe('["backend:8080"]');
    expect((await pullRow(replica.instanceId))?.resyncRequestedAt).toBeNull();
    [instance] = await runDriftChecks();
    expect(instance.drift.status).toBe('in_sync');

    [instance] = await runDriftChecks({ now: new Date(Date.now() + 5 * 60_000) });
    expect(instance.drift).toMatchObject({ status: 'unreachable', detail: expect.stringMatching(/not checked in for 3 poll intervals/) });
  });
});

describe('the agent', () => {
  it('follows no redirects, bounds the reply, and backs off on errors', async () => {
    const replica = await addReplica('edge');
    masterBehaviour = 'redirect';
    expect(await asReplica(replica, () => pullOnce(configOf(replica)))).toMatchObject({ kind: 'failed', error: expect.stringMatching(/redirect/) });
    expect(pollInits.at(-1)).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(pollInits.at(-1)?.signal).toBeInstanceOf(AbortSignal);
    masterBehaviour = 'huge';
    expect(await asReplica(replica, () => pullOnce(configOf(replica)))).toMatchObject({ kind: 'failed', error: 'The master sent an invalid reply' });

    masterBehaviour = 'down';
    const delays: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) delays.push(await asReplica(replica, () => runPullRound()));
    expect(delays[1]).toBeGreaterThan(delays[0]);
    expect(delays[2]).toBeGreaterThan(delays[1]);
    const { getPullAgentStatus } = await import('../../ee/fleet/pull-agent');
    expect(await asReplica(replica, async () => getPullAgentStatus())).toMatchObject({
      masterUrl: 'https://master.example.com', intervalSeconds: 30, failures: 3, lastError: expect.stringMatching(/network/),
    });
    // The credential never shows up in what the replica reports about itself.
    expect(JSON.stringify(await asReplica(replica, async () => getPullAgentStatus()))).not.toContain(replica.credential);

    masterBehaviour = null;
    const delay = await asReplica(replica, () => runPullRound());
    expect(delay).toBeLessThanOrEqual(36_000);
    expect(await asReplica(replica, async () => getPullAgentStatus())).toMatchObject({ failures: 0, lastError: null });
    expect(await hostsOn(replica)).toEqual(['App']);
  });
});

describe('license and permissions', () => {
  it('needs the license to add replicas and rotate credentials, never to revoke, delete or serve', async () => {
    const replica = await addReplica('edge');
    await removeLicense();
    await expect(createPullReplica({ name: 'other' }, adminId)).rejects.toMatchObject({ status: 403 });
    await expect(rotatePullCredential(replica.instanceId, adminId)).rejects.toMatchObject({ status: 403 });

    // A configured replica keeps working.
    await round(replica);
    expect(await hostsOn(replica)).toEqual(['App']);
    await addMasterHost('New');
    await round(replica);
    expect(await hostsOn(replica)).toEqual(['App', 'New']);

    const identity = (await instanceRow(replica.instanceId)).baseUrl;
    expect(await getSyncKeyPin(identity)).not.toBeNull();
    await revokePullCredential(replica.instanceId, adminId);
    await deletePullReplica(replica.instanceId, adminId);
    expect(await listPullReplicas()).toEqual([]);
    expect(await pullRow(replica.instanceId)).toBeUndefined();
    // Its key pin goes with it.
    expect(await getSyncKeyPin(identity)).toBeNull();
    expect(auditActions()).toEqual(expect.arrayContaining(['fleet_pull_replica_deleted', 'instance_sync_key_unpinned']));
  });

  it('makes fleet:replicas administrator-level and unavailable to scoped roles', () => {
    expect(isAdminLevel(['fleet:replicas'])).toBe(true);
    expect(isAdminLevel(['fleet:read', 'fleet:write', 'fleet:promote'])).toBe(false);
    expect(UNSCOPED_ONLY_PERMISSIONS).toContain('fleet:replicas');
  });

  it('serves the REST routes with fleet:read and fleet:replicas', async () => {
    const json = (body: unknown) => new NextRequest('https://master.example.com/api/v1/fleet/pull-replicas', { method: 'POST', body: JSON.stringify(body) });
    const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
    const created = await createRoute(json({ name: 'edge' }));
    expect(created.status).toBe(201);
    const issued = await created.json();
    expect(issued.credential).toMatch(/^pull_/);

    ctx.access = access('fleet:read');
    const listed = await listRoute(new NextRequest('https://master.example.com/api/v1/fleet/pull-replicas'));
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).not.toContain(issued.credential);
    expect((await getRoute(new NextRequest('https://master.example.com/x'), params(issued.replica.id))).status).toBe(200);
    expect((await createRoute(json({ name: 'x' }))).status).toBe(403);
    expect((await rotateRoute(new NextRequest('https://master.example.com/x', { method: 'POST' }), params(issued.replica.id))).status).toBe(403);
    expect((await revokeRoute(new NextRequest('https://master.example.com/x', { method: 'DELETE' }), params(issued.replica.id))).status).toBe(403);
    expect((await deleteRoute(new NextRequest('https://master.example.com/x', { method: 'DELETE' }), params(issued.replica.id))).status).toBe(403);

    ctx.access = access('fleet:read', 'fleet:replicas');
    const rotated = await rotateRoute(new NextRequest('https://master.example.com/x', { method: 'POST' }), params(issued.replica.id));
    expect(rotated.status).toBe(200);
    expect((await rotated.json()).credential).not.toBe(issued.credential);
    expect((await revokeRoute(new NextRequest('https://master.example.com/x', { method: 'DELETE' }), params(issued.replica.id))).status).toBe(200);
    expect((await getRoute(new NextRequest('https://master.example.com/x'), params(9999))).status).toBe(404);
    expect((await deleteRoute(new NextRequest('https://master.example.com/x', { method: 'DELETE' }), params(issued.replica.id))).status).toBe(204);
    // A push instance is not a pull replica.
    const pushed = await createInstance({ name: 'pushed', baseUrl: 'https://pushed.example.com', apiToken: 'fleet-sync-token-pushed-0123456789abcdef0123' });
    expect((await getRoute(new NextRequest('https://master.example.com/x'), params(pushed.id))).status).toBe(404);
  });
});

describe('Instance sync page', () => {
  type InstancesProps = Parameters<typeof InstancesClient>[0];

  async function renderSettings() {
    const element = (await InstancesPage()) as { props: InstancesProps };
    return { props: element.props, html: renderToStaticMarkup(createElement(InstancesClient, element.props)) };
  }

  it('lists pull replicas on the master, and shows a replica where it polls', async () => {
    const replica = await addReplica('edge');
    await round(replica);

    const { props, html } = await renderSettings();
    expect(props.instanceSync?.master?.pullReplicas?.replicas).toEqual([expect.objectContaining({ name: 'edge', checkIn: 'ok' })]);
    expect(html).toContain('Pull replicas');
    expect(html).toContain('Add pull replica');
    expect(html).toContain('>Pull replica<');
    expect(html).toContain('Checking in');
    expect(html).not.toContain(replica.credential);

    const own = await asReplica(replica, renderSettings);
    expect(own.props.instanceSync?.slave?.pull).toMatchObject({ masterUrl: 'https://master.example.com', intervalSeconds: 30, lastError: null });
    expect(own.html).toContain('Master connection (pull)');
    expect(own.html).toContain('accepts no');
    expect(own.html).not.toContain('Master sync token');
    expect(own.html).not.toContain(replica.credential);
  });
});
