/**
 * REST endpoints of API monetization (/api/v1/monetization/*): reading and
 * winding down, validation, secret redaction of the Stripe settings, the rule that a sync
 * slave cannot turn it on, monetization as an authentication mode of its own (both ways round),
 * keys shown once, idempotent adjustments, the ledger, the permission
 * catalogue and instance sync leaving monetized hosts on the master.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { setSettingRow } from '../helpers/config-fixture';
import { insertConsumer, insertKey, insertMonetizedHost, insertProxyHost } from '../helpers/monetization';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

vi.mock('../../src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-auth')>();
  return { ...actual, requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))), requireApiAdmin: vi.fn() };
});

import { requireApiAdmin } from '../../src/lib/api-auth';
import { applyCaddyConfig } from '../../src/lib/caddy';
import { logAuditEvent } from '../../src/lib/audit';
import { PERMISSION_AREAS, isAdminLevel, isPermission } from '../../src/lib/permissions';
import { decryptSecret, isEncryptedSecret } from '../../src/lib/secret';
import { updateProxyHost } from '../../src/lib/models/proxy-hosts';
import { buildSyncPayload } from '../../src/lib/instance-sync';
import { decideGate, reloadMonetization, resetMonetizationEngineForTests } from '../../ee/monetization/engine';
import { readGateSecret } from '../../ee/monetization/settings';
import * as plansRoute from '../../app/api/v1/monetization/plans/route';
import * as planRoute from '../../app/api/v1/monetization/plans/[id]/route';
import * as consumersRoute from '../../app/api/v1/monetization/consumers/route';
import * as consumerRoute from '../../app/api/v1/monetization/consumers/[id]/route';
import * as keysRoute from '../../app/api/v1/monetization/consumers/[id]/keys/route';
import * as keyRoute from '../../app/api/v1/monetization/consumers/[id]/keys/[keyId]/route';
import * as adjustRoute from '../../app/api/v1/monetization/consumers/[id]/adjust/route';
import * as portalRoute from '../../app/api/v1/monetization/consumers/[id]/portal-link/route';
import * as hostsRoute from '../../app/api/v1/monetization/hosts/route';
import * as hostRoute from '../../app/api/v1/monetization/hosts/[id]/route';
import * as stripeRoute from '../../app/api/v1/monetization/stripe/route';
import * as ledgerRoute from '../../app/api/v1/monetization/ledger/route';
import { GET as getOpenApi } from '../../app/api/v1/openapi.json/route';
import { first as dbFirst } from '@/src/lib/db/ops';

const SECRET_KEY = 'sk_test_SENTINELsecretKey1234567890';
const WEBHOOK_SECRET = 'whsec_SENTINELwebhookSecret123456';
const ADMIN_ID = 1;

function req(method: string, path: string, body?: unknown): NextRequest {
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers: {} };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  return new NextRequest(`http://localhost${path}`, init);
}
const params = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });
const keyParams = (id: number, keyId: number) => ({ params: Promise.resolve({ id: String(id), keyId: String(keyId) }) });

async function createPlan(body: Record<string, unknown> = {}) {
  const response = await plansRoute.POST(req('POST', '/api/v1/monetization/plans', { name: 'Standard', pricePerRequestMicros: 1_000, ...body }));
  expect(response.status).toBe(201);
  return response.json();
}

async function createConsumer(body: Record<string, unknown> = {}) {
  const response = await consumersRoute.POST(req('POST', '/api/v1/monetization/consumers', { name: 'Acme', ...body }));
  expect(response.status).toBe(201);
  return response.json();
}

beforeEach(async () => {
  ctx.db = createTestDb();
  resetMonetizationEngineForTests();
  vi.clearAllMocks();
  vi.mocked(applyCaddyConfig).mockResolvedValue(undefined as never);
  const t = new Date().toISOString();
  await ctx.db.insert(schema.users).values({ id: ADMIN_ID, email: 'admin@example.com', name: 'Admin', role: 'admin', status: 'active', createdAt: t, updatedAt: t });
  vi.mocked(requireApiAdmin).mockResolvedValue({ userId: ADMIN_ID, role: 'admin', authMethod: 'bearer' });
});

describe('winding down', () => {
  it('reads, disables, revokes, turns off and deletes', async () => {
    const plan = await createPlan();
    const consumer = await createConsumer({ planId: plan.id });
    const key = await (await keysRoute.POST(req('POST', '/x', { name: 'prod' }), params(consumer.id))).json();
    await portalRoute.POST(req('POST', '/x'), params(consumer.id));
    const host = await insertProxyHost(ctx.db);
    expect((await hostRoute.PUT(req('PUT', '/x', { enabled: true }), params(host.id))).status).toBe(200);
    await stripeRoute.PUT(req('PUT', '/x', { secretKey: SECRET_KEY, webhookSecret: WEBHOOK_SECRET, topUpAmountsMicros: [10_000_000] }));

    for (const response of [
      await plansRoute.GET(req('GET', '/x')),
      await consumersRoute.GET(req('GET', '/x')),
      await consumerRoute.GET(req('GET', '/x'), params(consumer.id)),
      await keysRoute.GET(req('GET', '/x'), params(consumer.id)),
      await hostsRoute.GET(req('GET', '/x')),
      await hostRoute.GET(req('GET', '/x'), params(host.id)),
      await stripeRoute.GET(req('GET', '/x')),
      await ledgerRoute.GET(req('GET', '/x')),
    ]) {
      expect(response.status).toBe(200);
    }

    const disable = await consumerRoute.PUT(req('PUT', '/x', { status: 'disabled', name: 'Acme' }), params(consumer.id));
    expect(disable.status).toBe(200);
    expect((await disable.json()).status).toBe('disabled');
    expect((await keyRoute.DELETE(req('DELETE', '/x'), keyParams(consumer.id, key.key.id))).status).toBe(204);
    expect((await portalRoute.DELETE(req('DELETE', '/x'), params(consumer.id))).status).toBe(204);
    const off = await hostRoute.PUT(req('PUT', '/x', { enabled: false }), params(host.id));
    expect(off.status).toBe(200);
    expect((await off.json()).monetization.enabled).toBe(false);
    expect((await hostRoute.DELETE(req('DELETE', '/x'), params(host.id))).status).toBe(204);
    expect((await stripeRoute.DELETE(req('DELETE', '/x'))).status).toBe(200);
    expect((await consumerRoute.DELETE(req('DELETE', '/x'), params(consumer.id))).status).toBe(204);
    expect((await planRoute.DELETE(req('DELETE', '/x'), params(plan.id))).status).toBe(204);
  });
});

describe('plans', () => {
  it('creates, validates, updates and refuses deleting a plan in use', async () => {
    const plan = await createPlan({ includedRequestsPerMonth: 100, requestsPerMinute: 60 });
    expect(plan).toMatchObject({ name: 'Standard', pricePerRequestMicros: 1_000, includedRequestsPerMonth: 100, requestsPerMinute: 60, consumerCount: 0 });

    for (const body of [
      { name: '', pricePerRequestMicros: 1 },
      { name: 'X' },
      { name: 'X', pricePerRequestMicros: -1 },
      { name: 'X', pricePerRequestMicros: 1.5 },
      { name: 'X', pricePerRequestMicros: 1, requestsPerMinute: -3 },
      { name: 'X', pricePerRequestMicros: 1, surprise: true },
    ]) {
      expect((await plansRoute.POST(req('POST', '/x', body))).status, JSON.stringify(body)).toBe(400);
    }
    expect((await plansRoute.POST(req('POST', '/x', { name: 'standard', pricePerRequestMicros: 1 }))).status).toBe(409);
    expect((await plansRoute.POST(req('POST', '/x', 'not json'))).status).toBe(400);

    const updated = await (await planRoute.PUT(req('PUT', '/x', { requestsPerMinute: null }), params(plan.id))).json();
    expect(updated.requestsPerMinute).toBeNull();
    expect((await planRoute.GET(req('GET', '/x'), params(999))).status).toBe(404);

    await createConsumer({ planId: plan.id });
    const refused = await planRoute.DELETE(req('DELETE', '/x'), params(plan.id));
    expect(refused.status).toBe(409);
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'monetization_plan', action: 'create' }));
  });

  it('refuses deleting a plan a host allows', async () => {
    const plan = await createPlan();
    const host = await insertProxyHost(ctx.db);
    expect((await hostRoute.PUT(req('PUT', '/x', { allowedPlanIds: [plan.id] }), params(host.id))).status).toBe(200);
    expect((await planRoute.DELETE(req('DELETE', '/x'), params(plan.id))).status).toBe(409);
  });
});

describe('consumers, keys, adjustments and portal links', () => {
  it('creates a consumer and validates its fields', async () => {
    const plan = await createPlan();
    const consumer = await createConsumer({ planId: plan.id, email: 'dev@example.com', overdraftAllowanceMicros: 500_000 });
    expect(consumer).toMatchObject({ name: 'Acme', status: 'active', planId: plan.id, planName: 'Standard', balanceMicros: 0, overdraftAllowanceMicros: 500_000, keys: [] });
    for (const body of [{ name: 'X', planId: 999 }, { name: 'X', email: 'nope' }, { name: 'X', status: 'paused' }, { name: 'X', overdraftAllowanceMicros: -1 }]) {
      expect((await consumersRoute.POST(req('POST', '/x', body))).status, JSON.stringify(body)).toBe(400);
    }
    expect((await consumerRoute.GET(req('GET', '/x'), params('abc'))).status).toBe(404);
  });

  it('shows a new key once and only its prefix afterwards; the gate accepts it until it is revoked', async () => {
    const plan = await createPlan({ pricePerRequestMicros: 0 });
    const consumer = await createConsumer({ planId: plan.id });
    const created = await keysRoute.POST(req('POST', '/x', { name: 'prod' }), params(consumer.id));
    expect(created.status).toBe(201);
    const { key, rawKey } = await created.json();
    expect(rawKey).toMatch(/^ik_[a-f0-9]{12}_[A-Za-z0-9_-]{43}$/);
    expect(rawKey.startsWith(`${key.prefix}_`)).toBe(true);

    const listed = JSON.stringify(await (await keysRoute.GET(req('GET', '/x'), params(consumer.id))).json());
    const detail = JSON.stringify(await (await consumerRoute.GET(req('GET', '/x'), params(consumer.id))).json());
    for (const text of [listed, detail]) {
      expect(text).toContain(key.prefix);
      expect(text).not.toContain(rawKey);
    }
    const row = (await dbFirst(ctx.db.select().from(schema.monetizationKeys).limit(1)))!;
    expect(row.keyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(vi.mocked(logAuditEvent).mock.calls)).not.toContain(rawKey);

    const host = await insertProxyHost(ctx.db);
    expect((await hostRoute.PUT(req('PUT', '/x', {}), params(host.id))).status).toBe(200);
    const gate = async (raw: string) =>
      decideGate({ gateToken: (await readGateSecret())!.token, hostId: String(host.id), header: (name) => (name === 'authorization' ? `Bearer ${raw}` : null) });
    expect(await gate(rawKey)).toMatchObject({ allow: true });
    expect((await keyRoute.DELETE(req('DELETE', '/x'), keyParams(consumer.id, key.id))).status).toBe(204);
    expect(await gate(rawKey)).toMatchObject({ status: 401 });
    expect((await keyRoute.DELETE(req('DELETE', '/x'), keyParams(consumer.id + 1, key.id))).status).toBe(404);
  });

  it('caps active keys per consumer', async () => {
    const consumer = await insertConsumer(ctx.db);
    for (let i = 0; i < 20; i += 1) await insertKey(ctx.db, consumer.id);
    expect((await keysRoute.POST(req('POST', '/x', {}), params(consumer.id))).status).toBe(409);
  });

  it('adjusts a balance with a reason, records it in the ledger and refuses a repeated reference', async () => {
    const consumer = await createConsumer();
    const first = await adjustRoute.POST(req('POST', '/x', { amountMicros: 5_000_000, reason: 'Welcome credit', reference: 'crm-42' }), params(consumer.id));
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ balanceMicros: 5_000_000, entry: { type: 'adjustment', amountMicros: 5_000_000, description: 'Welcome credit', createdBy: ADMIN_ID } });
    const again = await adjustRoute.POST(req('POST', '/x', { amountMicros: 5_000_000, reason: 'Welcome credit', reference: 'crm-42' }), params(consumer.id));
    expect(again.status).toBe(409);
    const minus = await adjustRoute.POST(req('POST', '/x', { amountMicros: -1_000_000, reason: 'Refund outside Stripe' }), params(consumer.id));
    expect((await minus.json()).balanceMicros).toBe(4_000_000);
    for (const body of [{ amountMicros: 0, reason: 'x' }, { amountMicros: 1 }, { amountMicros: 1.5, reason: 'x' }, { amountMicros: 1, reason: 'x', reference: 'has space' }]) {
      expect((await adjustRoute.POST(req('POST', '/x', body), params(consumer.id))).status, JSON.stringify(body)).toBe(400);
    }
    const ledger = await (await ledgerRoute.GET(req('GET', `/api/v1/monetization/ledger?consumerId=${consumer.id}&type=adjustment`))).json();
    expect(ledger.total).toBe(2);
    expect(ledger.entries.map((entry: { amountMicros: number }) => entry.amountMicros)).toEqual([-1_000_000, 5_000_000]);
    expect(ledger.entries[0]).toMatchObject({ consumerName: 'Acme', balanceAfterMicros: 4_000_000 });
    expect((await ledgerRoute.GET(req('GET', '/api/v1/monetization/ledger?type=chargeback'))).status).toBe(400);
    expect((await ledgerRoute.GET(req('GET', '/api/v1/monetization/ledger?type=refund'))).status).toBe(200);
  });

  it('issues a portal link once, stores only its hash and rotates it', async () => {
    const consumer = await createConsumer();
    const first = await (await portalRoute.POST(req('POST', '/x'), params(consumer.id))).json();
    expect(first.url).toMatch(/\/api-portal\/[A-Za-z0-9_-]{43}$/);
    expect(first.url.endsWith(first.token)).toBe(true);
    const row = async () => (await dbFirst(ctx.db.select().from(schema.monetizationConsumers).limit(1)))!;
    expect((await row()).portalTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await row()).portalTokenHash).not.toContain(first.token);
    const second = await (await portalRoute.POST(req('POST', '/x'), params(consumer.id))).json();
    expect(second.token).not.toBe(first.token);
    expect((await (await consumerRoute.GET(req('GET', '/x'), params(consumer.id))).json()).hasPortalLink).toBe(true);
    expect(JSON.stringify(await (await consumerRoute.GET(req('GET', '/x'), params(consumer.id))).json())).not.toContain(second.token);
  });

  it('writes pending usage and keeps the ledger when a consumer is deleted', async () => {
    const plan = await createPlan({ pricePerRequestMicros: 1_000 });
    const consumer = await createConsumer({ planId: plan.id });
    await adjustRoute.POST(req('POST', '/x', { amountMicros: 10_000, reason: 'Credit' }), params(consumer.id));
    const { rawKey } = await (await keysRoute.POST(req('POST', '/x', {}), params(consumer.id))).json();
    const host = await insertProxyHost(ctx.db);
    await hostRoute.PUT(req('PUT', '/x', {}), params(host.id));
    decideGate({ gateToken: (await readGateSecret())!.token, hostId: String(host.id), header: (name) => (name === 'authorization' ? `Bearer ${rawKey}` : null) });

    expect((await consumerRoute.DELETE(req('DELETE', '/x'), params(consumer.id))).status).toBe(204);
    expect(await ctx.db.select().from(schema.monetizationKeys)).toHaveLength(0);
    const types = (await ctx.db.select().from(schema.monetizationLedger)).map((entry) => entry.type).sort();
    expect(types).toEqual(['adjustment', 'usage']);
    const ledger = await (await ledgerRoute.GET(req('GET', '/x'))).json();
    expect(ledger.entries[0].consumerName).toBeNull();
  });
});

describe('hosts', () => {
  it('turns monetization on, re-applies Caddy and lists the host', async () => {
    const plan = await createPlan();
    const host = await insertProxyHost(ctx.db);
    const response = await hostRoute.PUT(req('PUT', '/x', { keyHeader: 'x-api-key', allowedPlanIds: [plan.id] }), params(host.id));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ proxyHostId: host.id, monetization: { enabled: true, keyHeader: 'x-api-key', allowedPlanIds: [plan.id] }, conflicts: [] });
    expect(vi.mocked(applyCaddyConfig)).toHaveBeenCalled();
    expect(await readGateSecret()).not.toBeNull();
    const list = await (await hostsRoute.GET(req('GET', '/x'))).json();
    expect(list).toHaveLength(1);

    for (const body of [{ keyHeader: 'Cookie' }, { keyHeader: 'X-Forwarded-For' }, { keyHeader: 'X-Ingressi-Key' }, { keyHeader: 'bad header' }, { allowedPlanIds: [999] }, { enabled: 'yes' }]) {
      expect((await hostRoute.PUT(req('PUT', '/x', body), params(host.id))).status, JSON.stringify(body)).toBe(400);
    }
    expect((await hostRoute.PUT(req('PUT', '/x', {}), params(999))).status).toBe(404);
  });

  it('allows turning it on on a sync master (it gates there), refuses it on a slave (409), and always allows turning it off', async () => {
    const host = await insertProxyHost(ctx.db);
    expect((await hostRoute.PUT(req('PUT', '/x', {}), params(host.id))).status).toBe(200);
    await setSettingRow(ctx.db, 'instance_mode', 'master');
    expect((await hostRoute.PUT(req('PUT', '/x', { keyHeader: 'X-API-Key' }), params(host.id))).status).toBe(200);
    await setSettingRow(ctx.db, 'instance_mode', 'slave');
    const refused = await hostRoute.PUT(req('PUT', '/x', { keyHeader: 'X-Key' }), params(host.id));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toContain('sync replica');
    expect((await hostRoute.PUT(req('PUT', '/x', { enabled: false }), params(host.id))).status).toBe(200);
  });

  it('is an authentication mode: refused next to forward auth or an access list, and those refused next to it', async () => {
    const t = new Date().toISOString();
    const list = (await dbFirst(ctx.db.insert(schema.accessLists).values({ name: 'Staff', createdAt: t, updatedAt: t }).returning()))!;
    const withList = await insertProxyHost(ctx.db, { name: 'Listed', accessListId: list.id });
    const withForwardAuth = await insertProxyHost(ctx.db, { name: 'FA', meta: JSON.stringify({ cpm_forward_auth: { enabled: true } }) });
    const withAuthentik = await insertProxyHost(ctx.db, {
      name: 'AK',
      meta: JSON.stringify({ authentik: { enabled: true, outpost_domain: 'outpost.goauthentik.io', outpost_upstream: 'http://ak:9000' } }),
    });
    for (const host of [withList, withForwardAuth, withAuthentik]) {
      const response = await hostRoute.PUT(req('PUT', '/x', {}), params(host.id));
      expect(response.status, host.name).toBe(400);
      expect((await response.json()).error).toContain('authentication mode');
    }
    const view = await (await hostRoute.GET(req('GET', '/x'), params(withList.id))).json();
    expect(view.conflicts).toEqual(['a basic-auth access list']);

    const monetized = await insertProxyHost(ctx.db, { name: 'Monetized' });
    expect((await hostRoute.PUT(req('PUT', '/x', {}), params(monetized.id))).status).toBe(200);
    await expect(updateProxyHost(monetized.id, { accessListId: list.id }, ADMIN_ID)).rejects.toThrow(/API monetization is on/);
    await expect(updateProxyHost(monetized.id, { ingressiForwardAuth: { enabled: true } }, ADMIN_ID)).rejects.toThrow(/API monetization is on/);
    await expect(updateProxyHost(monetized.id, { forwardAuth: { enabled: true, authUpstream: 'http://authelia:9091' } } as never, ADMIN_ID)).rejects.toThrow(/API monetization is on/);
    // Unrelated edits, and turning the auth modes off, still work.
    await expect(updateProxyHost(monetized.id, { name: 'Renamed', accessListId: null }, ADMIN_ID)).resolves.toMatchObject({ name: 'Renamed' });
  });

  it('forgets a deleted proxy host', async () => {
    const { deleteProxyHost } = await import('../../src/lib/models/proxy-hosts');
    const host = await insertProxyHost(ctx.db);
    await hostRoute.PUT(req('PUT', '/x', {}), params(host.id));
    await deleteProxyHost(host.id, ADMIN_ID);
    expect(await ctx.db.select().from(schema.monetizationHosts)).toHaveLength(0);
  });

  it('keeps monetized hosts out of the instance sync payload', async () => {
    const plain = await insertProxyHost(ctx.db, { name: 'Plain', domains: '["plain.example.com"]' });
    const monetized = await insertProxyHost(ctx.db, { name: 'Paid' });
    await insertMonetizedHost(ctx.db, monetized.id);
    const payload = await buildSyncPayload();
    expect(payload.data.proxyHosts.map((host) => host.id)).toEqual([plain.id]);
  });
});

describe('Stripe settings', () => {
  it('stores the secrets encrypted and never returns them', async () => {
    const saved = await stripeRoute.PUT(
      req('PUT', '/x', { secretKey: SECRET_KEY, webhookSecret: WEBHOOK_SECRET, currency: 'EUR', topUpAmountsMicros: [25_000_000, 10_000_000], topUpUrl: 'https://developers.example.com/billing' })
    );
    expect(saved.status).toBe(200);
    const view = await saved.json();
    expect(view).toMatchObject({
      configured: true, hasSecretKey: true, hasWebhookSecret: true, mode: 'test', currency: 'eur',
      topUpAmountsMicros: [10_000_000, 25_000_000], topUpUrl: 'https://developers.example.com/billing',
      webhookEvents: [
        'checkout.session.completed',
        'checkout.session.async_payment_succeeded',
        'setup_intent.succeeded',
        'payment_intent.succeeded',
        'payment_intent.payment_failed',
        'charge.refunded',
        'charge.dispute.created',
      ],
      automaticTax: false,
    });
    expect(view.webhookUrl).toMatch(/\/api\/monetization\/stripe\/webhook$/);

    const everything = JSON.stringify([
      view,
      await (await stripeRoute.GET(req('GET', '/x'))).json(),
      vi.mocked(logAuditEvent).mock.calls,
    ]);
    for (const secret of [SECRET_KEY, WEBHOOK_SECRET, 'SENTINEL']) expect(everything).not.toContain(secret);

    const stored = JSON.parse((await dbFirst(ctx.db.select().from(schema.settings).where(eq(schema.settings.key, 'monetization_payments')).limit(1)))!.value);
    expect(isEncryptedSecret(stored.secretKey)).toBe(true);
    expect(isEncryptedSecret(stored.webhookSecret)).toBe(true);
    expect(decryptSecret(stored.secretKey)).toBe(SECRET_KEY);

    // Omitted secrets are kept.
    const kept = await (await stripeRoute.PUT(req('PUT', '/x', { topUpAmountsMicros: [5_000_000] }))).json();
    expect(kept).toMatchObject({ configured: true, topUpAmountsMicros: [5_000_000] });

    const removed = await (await stripeRoute.DELETE(req('DELETE', '/x'))).json();
    expect(removed).toMatchObject({ configured: false, hasSecretKey: false, hasWebhookSecret: false, currency: 'eur' });
  });

  it('validates keys, currency and amounts, and refuses a currency change while balances are non-zero', async () => {
    for (const body of [
      { secretKey: 'pk_test_publishableKey123' },
      { webhookSecret: 'not-a-secret' },
      { currency: 'euro' },
      { topUpAmountsMicros: [] },
      { topUpAmountsMicros: [1_234] }, // not a whole cent
      { topUpUrl: 'http://insecure.example.com' },
    ]) {
      expect((await stripeRoute.PUT(req('PUT', '/x', body))).status, JSON.stringify(body)).toBe(400);
    }
    await insertConsumer(ctx.db, { balanceMicros: 1 });
    expect((await stripeRoute.PUT(req('PUT', '/x', { currency: 'eur' }))).status).toBe(409);
    expect((await stripeRoute.PUT(req('PUT', '/x', { currency: 'usd' }))).status).toBe(200);
  });
});

describe('permissions and documentation', () => {
  it('has an instance-wide monetization area with read, write and administrator-level payments', () => {
    expect(PERMISSION_AREAS.monetization).toMatchObject({ actions: ['read', 'write', 'payments'], instanceWide: true });
    expect(isPermission('monetization:read')).toBe(true);
    expect(isPermission('monetization:write')).toBe(true);
    expect(isPermission('monetization:payments')).toBe(true);
    expect(isAdminLevel(['monetization:payments'])).toBe(true);
    expect(isAdminLevel(['monetization:write'])).toBe(false);
  });

  it('documents every endpoint in OpenAPI with resolvable references and write-only secrets', async () => {
    const spec = await (await getOpenApi(req('GET', '/api/v1/openapi.json'))).json();
    const expected: Record<string, string[]> = {
      '/api/v1/monetization/plans': ['get', 'post'],
      '/api/v1/monetization/plans/{id}': ['get', 'put', 'delete'],
      '/api/v1/monetization/consumers': ['get', 'post'],
      '/api/v1/monetization/consumers/{id}': ['get', 'put', 'delete'],
      '/api/v1/monetization/consumers/{id}/keys': ['get', 'post'],
      '/api/v1/monetization/consumers/{id}/keys/{keyId}': ['delete'],
      '/api/v1/monetization/consumers/{id}/adjust': ['post'],
      '/api/v1/monetization/consumers/{id}/portal-link': ['post', 'delete'],
      '/api/v1/monetization/hosts': ['get'],
      '/api/v1/monetization/hosts/{id}': ['get', 'put', 'delete'],
      '/api/v1/monetization/stripe': ['get', 'put', 'delete'],
      '/api/v1/monetization/ledger': ['get'],
      '/api/v1/monetization/overview': ['get'],
    };
    for (const [path, methods] of Object.entries(expected)) {
      expect(Object.keys(spec.paths[path]).sort(), path).toEqual([...methods].sort());
      for (const method of methods) {
        expect(spec.paths[path][method].tags).toEqual(['API Monetization']);
        expect(spec.paths[path][method].operationId).toBeTruthy();
      }
    }
    const refs = JSON.stringify(Object.fromEntries(Object.keys(expected).map((path) => [path, spec.paths[path]]))).match(/"\$ref":"#\/components\/[^"]+"/g) ?? [];
    const schemaRefs = JSON.stringify(Object.entries(spec.components.schemas).filter(([name]) => name.startsWith('Monetization'))).match(/"\$ref":"#\/components\/[^"]+"/g) ?? [];
    for (const ref of new Set([...refs, ...schemaRefs])) {
      const path = JSON.parse(`{${ref}}`).$ref.slice('#/'.length).split('/');
      expect(path.reduce((node: any, key: string) => node?.[key], spec), ref).toBeDefined();
    }
    const input = spec.components.schemas.MonetizationStripeSettingsInput.properties;
    expect(input.secretKey.writeOnly).toBe(true);
    expect(input.webhookSecret.writeOnly).toBe(true);
    const output = JSON.stringify(spec.components.schemas.MonetizationStripeSettings);
    expect(output).not.toContain('"secretKey"');
    expect(output).not.toContain('"webhookSecret"');
  });
});

describe('gate reload after administrator changes', () => {
  it('applies plan, consumer and balance changes to the next request', async () => {
    const plan = await createPlan({ pricePerRequestMicros: 1_000 });
    const consumer = await createConsumer({ planId: plan.id });
    const { rawKey } = await (await keysRoute.POST(req('POST', '/x', {}), params(consumer.id))).json();
    const host = await insertProxyHost(ctx.db);
    await hostRoute.PUT(req('PUT', '/x', {}), params(host.id));
    await reloadMonetization();
    const gate = async () => decideGate({ gateToken: (await readGateSecret())!.token, hostId: String(host.id), header: (name) => (name === 'authorization' ? `Bearer ${rawKey}` : null) });

    expect(await gate()).toMatchObject({ status: 402 });
    await consumerRoute.PUT(req('PUT', '/x', { overdraftAllowanceMicros: 1_000 }), params(consumer.id));
    expect(await gate()).toMatchObject({ allow: true });
    expect(await gate()).toMatchObject({ status: 402 });
    await adjustRoute.POST(req('POST', '/x', { amountMicros: 1_000, reason: 'Top-up by bank transfer' }), params(consumer.id));
    expect(await gate()).toMatchObject({ allow: true });
    await planRoute.PUT(req('PUT', '/x', { pricePerRequestMicros: 0 }), params(plan.id));
    expect(await gate()).toMatchObject({ allow: true, chargedMicros: 0 });
    await consumerRoute.PUT(req('PUT', '/x', { status: 'disabled' }), params(consumer.id));
    expect(await gate()).toMatchObject({ status: 403, error: 'consumer_disabled' });
  });
});
