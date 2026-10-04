/**
 * High availability, phase 3 (ee/high-availability/shared-state): the shared
 * state switch over REST and dashboard actions, the license gate (turning on
 * and changing need it; turning off, removing, reading and the status never
 * do), the check that this web container reaches the server, writing the
 * balances back before turning off, slaves, the status, the certificate
 * storage guard and the OpenAPI entries.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { createTestDb, type TestDb } from '../helpers/db';
import { createTestSigner, licensePayload, signLicense } from '../helpers/license';
import { insertConsumer, insertKey, insertMonetizedHost, insertPlan, insertProxyHost } from '../helpers/monetization';
import * as schema from '../../src/lib/db/schema';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/src/lib/auth', () => ({
  auth: vi.fn(async () => null),
  checkSameOrigin: vi.fn(() => null),
  requirePermission: vi.fn(() => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireAdmin())),
  requireAdmin: vi.fn(async () => ({ user: { id: '1', role: 'admin' } })),
}));
vi.mock('@/src/lib/api-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/api-auth')>()),
  requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
  requireApiAdmin: vi.fn(async () => ({ userId: 1, role: 'admin', authMethod: 'bearer' })),
}));

import { DELETE, GET, PUT } from '@/app/api/v1/high-availability/shared-state/route';
import { GET as STATUS } from '@/app/api/v1/high-availability/shared-state/status/route';
import { DELETE as DELETE_STORAGE, PUT as PUT_STORAGE } from '@/app/api/v1/high-availability/storage/route';
import { GET as getOpenApi } from '@/app/api/v1/openapi.json/route';
import { removeSharedStateAction, saveSharedStateAction, sharedStateStatusAction } from '@/ee/high-availability/ui/shared-state-actions';
import { requireApiPermission } from '@/src/lib/api-auth';
import { requirePermission } from '@/src/lib/auth';
import { logAuditEvent } from '@/src/lib/audit';
import { setTrustedLicenseKeysForTests } from '@/ee/licensing/public-keys';
import { LICENSE_SETTING_KEY } from '@/ee/licensing/store';
import { invalidateSharedState, setSharedRedisClientFactoryForTests, getSharedState } from '@/ee/high-availability/shared-state/connection';
import { createRedisMonetizationStore } from '@/ee/high-availability/shared-state/monetization-store';
import { reloadMonetization, resetMonetizationEngineForTests } from '@/ee/monetization/engine';
import { ensureGateSecret } from '@/ee/monetization/settings';
import type { SharedStateStatus, SharedStateView } from '@/ee/high-availability/shared-state/types';
import { first } from '@/src/lib/db/ops';

const signer = createTestSigner();

async function setRow(key: string, value: unknown) {
  const json = JSON.stringify(value);
  const updatedAt = new Date().toISOString();
  await ctx.db.insert(schema.settings).values({ key, value: json, updatedAt })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: json, updatedAt } });
}

async function installLicense() {
  await setRow(LICENSE_SETTING_KEY, signLicense(signer, licensePayload(signer, { edition: 'enterprise', iat: '2026-01-01T00:00:00.000Z', exp: '2099-01-01T00:00:00.000Z' })));
}

async function removeLicense() {
  await ctx.db.delete(schema.settings).where(eq(schema.settings.key, LICENSE_SETTING_KEY));
}

/** Redis settings saved for the certificate storage, not enabled (phase 1 "save without enabling"). */
async function saveConnection(addresses = ['valkey.example.com:6379']) {
  await setRow('certificate_storage', {
    backend: 'local',
    redis: { mode: 'standalone', addresses, db: 0, keyPrefix: 'caddy', tls: { enabled: false, insecureSkipVerify: false } },
  });
  invalidateSharedState();
}

async function stored(): Promise<Record<string, unknown> | null> {
  const row = await first(ctx.db.select().from(schema.settings).where(eq(schema.settings.key, 'ha_shared_state')).limit(1));
  return row ? JSON.parse(row.value) : null;
}

async function call(handler: (request: NextRequest) => Promise<Response>, method: string, body?: unknown) {
  const response = await handler(new NextRequest('http://localhost/api/v1/high-availability/shared-state', {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  }));
  return { status: response.status, data: await response.json() };
}

let server: Redis;
let reachable = true;

beforeEach(async () => {
  ctx.db = createTestDb();
  vi.mocked(logAuditEvent).mockClear();
  delete process.env.INSTANCE_MODE;
  setTrustedLicenseKeysForTests(signer.keys);
  resetMonetizationEngineForTests();
  server = new RedisMock() as unknown as Redis;
  await server.flushall();
  reachable = true;
  setSharedRedisClientFactoryForTests(() => {
    const client = new RedisMock() as unknown as Redis;
    if (!reachable) {
      vi.spyOn(client, 'ping').mockRejectedValue(new Error('connect ECONNREFUSED'));
      vi.spyOn(client, 'hgetall').mockRejectedValue(new Error('connect ECONNREFUSED'));
    }
    return client;
  });
  invalidateSharedState();
});

afterEach(() => {
  setSharedRedisClientFactoryForTests(null);
  invalidateSharedState();
});

afterAll(() => {
  setTrustedLicenseKeysForTests(null);
});

describe('GET /api/v1/high-availability/shared-state', () => {
  it('reads without a license and names the permission', async () => {
    const { status, data } = await call(GET, 'GET');
    expect(status).toBe(200);
    expect(data as SharedStateView).toMatchObject({
      enabled: false,
      backend: 'local',
      configurable: false,
      editable: true,
      connection: { source: 'certificate_storage', configured: false },
    });
    expect(vi.mocked(requireApiPermission).mock.calls.at(-1)?.[1]).toBe('high_availability:read');
  });
});

describe('PUT /api/v1/high-availability/shared-state', () => {
  it('needs the license to turn on', async () => {
    await saveConnection();
    const { status } = await call(PUT, 'PUT', { enabled: true });
    expect(status).toBe(403);
    expect(await stored()).toBeNull();
  });

  it('needs the certificate storage connection', async () => {
    await installLicense();
    const { status, data } = await call(PUT, 'PUT', { enabled: true });
    expect(status).toBe(400);
    expect(data.error).toMatch(/certificate storage/);
  });

  it('refuses (502) when this web container cannot reach the server, and stores nothing', async () => {
    await installLicense();
    await saveConnection();
    reachable = false;
    const { status, data } = await call(PUT, 'PUT', { enabled: true });
    expect(status).toBe(502);
    expect(data.error).toMatch(/could not connect/);
    expect(await stored()).toBeNull();
  });

  it('turns on with a new generation, audits, and validates the prefix', async () => {
    await installLicense();
    await saveConnection();
    expect((await call(PUT, 'PUT', { enabled: true, keyPrefix: 'bad prefix' })).status).toBe(400);
    expect((await call(PUT, 'PUT', { enabled: true, unknown: 1 })).status).toBe(400);
    const { status, data } = await call(PUT, 'PUT', { enabled: true, keyPrefix: 'eu-west' });
    expect(status).toBe(200);
    expect(data as SharedStateView).toMatchObject({ enabled: true, backend: 'redis', keyPrefix: 'eu-west', connection: { configured: true, addresses: ['valkey.example.com:6379'] } });
    expect(data.namespace).toMatch(/^eu-west:[a-f0-9]{12}:$/);
    expect(vi.mocked(requireApiPermission).mock.calls.at(-1)?.[1]).toBe('high_availability:write');
    expect(vi.mocked(logAuditEvent).mock.calls.map(([event]) => event.action)).toContain('ha_shared_state_updated');
    expect(await getSharedState()).toMatchObject({ namespace: data.namespace });
  });

  it('refuses on a sync slave', async () => {
    await installLicense();
    await saveConnection();
    process.env.INSTANCE_MODE = 'slave';
    expect((await call(PUT, 'PUT', { enabled: true })).status).toBe(409);
    expect((await call(GET, 'GET')).data.editable).toBe(false);
  });

  it('writes the shared balances to the ledger before turning off, without a license', async () => {
    await installLicense();
    await saveConnection();
    expect((await call(PUT, 'PUT', { enabled: true })).status).toBe(200);
    const plan = await insertPlan(ctx.db, { pricePerRequestMicros: 100 });
    const consumer = await insertConsumer(ctx.db, { planId: plan.id, balanceMicros: 1_000 });
    const { raw } = await insertKey(ctx.db, consumer.id);
    const host = await insertProxyHost(ctx.db);
    await insertMonetizedHost(ctx.db, host.id);
    const { token } = await ensureGateSecret();
    await reloadMonetization();
    const state = (await getSharedState())!;
    const store = createRedisMonetizationStore(state);
    const headers = new Headers({ authorization: `Bearer ${raw}` });
    for (let index = 0; index < 3; index++) {
      expect(await store.decide({ gateToken: token, hostId: String(host.id), header: (name) => headers.get(name) })).toMatchObject({ allow: true });
    }
    await removeLicense();
    const { status, data } = await call(PUT, 'PUT', { enabled: false });
    expect(status).toBe(200);
    expect(data).toMatchObject({ enabled: false, backend: 'local' });
    const row = (await first(ctx.db.select().from(schema.monetizationConsumers).where(eq(schema.monetizationConsumers.id, consumer.id)).limit(1)))!;
    expect(row.balanceMicros).toBe(700);
  });

  it('keeps shared state on (502) when the balances cannot be written back', async () => {
    await installLicense();
    await saveConnection();
    expect((await call(PUT, 'PUT', { enabled: true })).status).toBe(200);
    await insertConsumer(ctx.db, { balanceMicros: 1 });
    reachable = false;
    setSharedRedisClientFactoryForTests(() => {
      const client = new RedisMock() as unknown as Redis;
      vi.spyOn(client, 'hgetall').mockRejectedValue(new Error('connect ECONNREFUSED'));
      return client;
    });
    const { status, data } = await call(PUT, 'PUT', { enabled: false });
    expect(status).toBe(502);
    expect(data.error).toMatch(/could not be written to the ledger/);
    expect(await stored()).toMatchObject({ enabled: true });

    // DELETE turns it off anyway, and records that the balances were not written.
    const removed = await call(DELETE, 'DELETE');
    expect(removed.status).toBe(200);
    expect(removed.data).toMatchObject({ enabled: false, backend: 'local' });
    expect(await stored()).toBeNull();
    const event = vi.mocked(logAuditEvent).mock.calls.map(([entry]) => entry).find((entry) => entry.action === 'ha_shared_state_removed');
    expect(event?.data).toMatchObject({ balances: 'failed' });
  });
});

describe('status', () => {
  it('reports off, then the keys, the drain and the leader', async () => {
    expect((await call(STATUS, 'GET')).data as SharedStateStatus).toMatchObject({ backend: 'local', reachable: null, keys: null });
    await installLicense();
    await saveConnection();
    await call(PUT, 'PUT', { enabled: true });
    const { status, data } = await call(STATUS, 'GET');
    expect(status).toBe(200);
    expect(data as SharedStateStatus).toMatchObject({
      backend: 'redis',
      reachable: true,
      keys: { forwardAuthSessions: 0, monetizationConsumers: 0, pendingCredits: 0 },
      leader: true,
    });
  });
});

describe('dashboard actions', () => {
  it('return client-safe refusals and name their permissions', async () => {
    await saveConnection();
    const refused = await saveSharedStateAction({ enabled: true });
    expect(refused).toMatchObject({ ok: false });
    expect(vi.mocked(requirePermission).mock.calls.at(-1)?.[0]).toBe('high_availability:write');
    await installLicense();
    expect(await saveSharedStateAction({ enabled: true })).toMatchObject({ ok: true, view: { enabled: true } });
    expect(await sharedStateStatusAction()).toMatchObject({ ok: true, status: { backend: 'redis' } });
    expect(vi.mocked(requirePermission).mock.calls.at(-1)?.[0]).toBe('high_availability:read');
    expect(await removeSharedStateAction()).toMatchObject({ ok: true, view: { enabled: false } });
  });
});

describe('certificate storage while shared state is on', () => {
  it('refuses moving to another server or removing the settings, allows other changes', async () => {
    await installLicense();
    await saveConnection();
    await call(PUT, 'PUT', { enabled: true });
    const moved = await call(PUT_STORAGE, 'PUT', { backend: 'local', redis: { mode: 'standalone', addresses: ['valkey-2.example.com:6379'], keyPrefix: 'caddy' } });
    expect(moved.status).toBe(409);
    expect(moved.data.error).toMatch(/shared state/);
    expect((await call(DELETE_STORAGE, 'DELETE')).status).toBe(409);
    const prefixOnly = await call(PUT_STORAGE, 'PUT', { backend: 'local', redis: { mode: 'standalone', addresses: ['valkey.example.com:6379'], keyPrefix: 'caddy/other' } });
    expect(prefixOnly.status).toBe(200);
  });
});

describe('OpenAPI', () => {
  it('documents the endpoints and schemas', async () => {
    const spec = await (await getOpenApi(new NextRequest('http://localhost/api/v1/openapi.json'))).json();
    expect(spec.paths['/api/v1/high-availability/shared-state']).toHaveProperty('put');
    expect(spec.paths['/api/v1/high-availability/shared-state']).toHaveProperty('delete');
    expect(spec.paths['/api/v1/high-availability/shared-state/status']).toHaveProperty('get');
    expect(spec.components.schemas).toHaveProperty('SharedStateStatus');
    expect(JSON.stringify(spec.components.schemas.SharedState)).not.toMatch(/password/i);
  });
});
