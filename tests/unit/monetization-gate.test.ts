/**
 * API monetization gate (ee/monetization/engine.ts, gate-response.ts): every
 * decision, the overdraft cap, free monthly requests, the per-minute limit,
 * revoked keys, disabled consumers, plans not allowed on a host, the gate
 * token, no database access on the hot path, and the flush to SQLite with a
 * reload afterwards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { insertConsumer, insertKey, insertMonetizedHost, insertPlan, insertProxyHost } from '../helpers/monetization';
import { countStatements } from '../helpers/statement-counter';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

import {
  decideGate,
  flushUsage,
  pendingUsage,
  reloadMonetization,
  resetMonetizationEngineForTests,
  type GateDecision,
} from '../../ee/monetization/engine';
import { gateResponse, handleGateRequest } from '../../ee/monetization/gate-response';
import { ensureGateSecret } from '../../ee/monetization/settings';
import { applyBalanceChange } from '../../ee/monetization/ledger';
import { first } from '@/src/lib/db/ops';

const T0 = Date.UTC(2026, 9, 3, 12, 0, 10);

type World = {
  token: string;
  hostId: number;
  planId: number;
  consumerId: number;
  key: string;
};

async function seed(options: {
  price?: number;
  included?: number;
  perMinute?: number | null;
  balance?: number;
  overdraft?: number;
  keyHeader?: string;
} = {}): Promise<World> {
  const plan = await insertPlan(ctx.db, {
    name: 'Standard',
    pricePerRequestMicros: options.price ?? 1_000,
    includedRequestsPerMonth: options.included ?? 0,
    requestsPerMinute: options.perMinute ?? null,
  });
  const consumer = await insertConsumer(ctx.db, {
    planId: plan.id,
    balanceMicros: options.balance ?? 10_000,
    overdraftAllowanceMicros: options.overdraft ?? 0,
  });
  const { raw } = await insertKey(ctx.db, consumer.id);
  const host = await insertProxyHost(ctx.db);
  await insertMonetizedHost(ctx.db, host.id, { keyHeader: options.keyHeader ?? 'Authorization' });
  const { token } = await ensureGateSecret();
  await reloadMonetization();
  return { token, hostId: host.id, planId: plan.id, consumerId: consumer.id, key: raw };
}

function call(world: World, overrides: { token?: string | null; hostId?: string | null; headers?: Record<string, string>; now?: number } = {}): GateDecision {
  const headers = new Headers(overrides.headers ?? { authorization: `Bearer ${world.key}` });
  return decideGate({
    gateToken: overrides.token === undefined ? world.token : overrides.token,
    hostId: overrides.hostId === undefined ? String(world.hostId) : overrides.hostId,
    header: (name) => headers.get(name),
    now: overrides.now ?? T0,
  });
}

beforeEach(() => {
  ctx.db = createTestDb();
  resetMonetizationEngineForTests();
});

afterEach(() => vi.restoreAllMocks());

describe('gate decisions', () => {
  it('charges a valid request and passes the consumer and plan to the upstream', async () => {
    const world = await seed({ price: 2_500, balance: 10_000 });
    const decision = call(world);
    expect(decision).toEqual({ allow: true, consumerId: world.consumerId, planId: world.planId, chargedMicros: 2_500, free: false });
    expect(pendingUsage(world.consumerId).chargeMicros).toBe(2_500);

    const response = gateResponse(call(world));
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Ingressi-Consumer-Id')).toBe(String(world.consumerId));
    expect(response.headers.get('X-Ingressi-Plan')).toBe(String(world.planId));
  });

  it('refuses calls without the gate token or with a wrong one (403, nothing else said)', async () => {
    const world = await seed();
    for (const token of [null, '', 'f'.repeat(64), `${world.token}x`, world.token.slice(1)]) {
      expect(call(world, { token })).toEqual({ allow: false, status: 403, error: 'forbidden' });
    }
    const response = gateResponse(call(world, { token: null }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });
    expect(pendingUsage(world.consumerId).requests).toBe(0);
  });

  it('refuses every call before a gate token exists', async () => {
    await insertMonetizedHost(ctx.db, (await insertProxyHost(ctx.db)).id);
    await reloadMonetization();
    expect(decideGate({ gateToken: 'anything', hostId: '1', header: () => null })).toMatchObject({ status: 403, error: 'forbidden' });
  });

  it('refuses hosts the gate does not know (403)', async () => {
    const world = await seed();
    expect(call(world, { hostId: String(world.hostId + 1) })).toMatchObject({ status: 403, error: 'host_not_monetized' });
    expect(call(world, { hostId: null })).toMatchObject({ status: 403, error: 'host_not_monetized' });
    expect(call(world, { hostId: '1 OR 1=1' })).toMatchObject({ status: 403, error: 'host_not_monetized' });
  });

  it('answers 401 for a missing, malformed or unknown key', async () => {
    const world = await seed();
    expect(call(world, { headers: {} })).toMatchObject({ status: 401, error: 'missing_api_key' });
    expect(call(world, { headers: { authorization: world.key } })).toMatchObject({ status: 401, error: 'missing_api_key' });
    expect(call(world, { headers: { authorization: 'Bearer nope' } })).toMatchObject({ status: 401, error: 'invalid_api_key' });
    // Right prefix, wrong secret.
    const forged = `${world.key.slice(0, 16)}${'A'.repeat(43)}`;
    expect(forged.slice(0, 16)).toBe(world.key.slice(0, 16));
    expect(call(world, { headers: { authorization: `Bearer ${forged}` } })).toMatchObject({ status: 401, error: 'invalid_api_key' });

    const response = gateResponse(call(world, { headers: {} }));
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer realm="api"');
    expect((await response.json()).error).toBe('missing_api_key');
  });

  it('reads the key from a custom header when the host says so', async () => {
    const world = await seed({ keyHeader: 'X-API-Key' });
    expect(call(world, { headers: { 'x-api-key': world.key } })).toMatchObject({ allow: true });
    expect(call(world)).toMatchObject({ status: 401, error: 'missing_api_key', keyHeader: 'X-API-Key' });
  });

  it('refuses a revoked key once the gate reloads', async () => {
    const world = await seed();
    expect(call(world)).toMatchObject({ allow: true });
    await ctx.db.update(schema.monetizationKeys).set({ revokedAt: new Date().toISOString() });
    await reloadMonetization();
    expect(call(world)).toMatchObject({ status: 401, error: 'invalid_api_key' });
  });

  it('refuses a disabled consumer (403)', async () => {
    const world = await seed();
    await ctx.db.update(schema.monetizationConsumers).set({ status: 'disabled' });
    await reloadMonetization();
    expect(call(world)).toMatchObject({ status: 403, error: 'consumer_disabled' });
  });

  it('refuses a plan the host does not allow, and a consumer without a plan (403)', async () => {
    const world = await seed();
    const other = await insertPlan(ctx.db, { name: 'Premium' });
    await ctx.db.update(schema.monetizationHosts).set({ allowedPlanIds: JSON.stringify([other.id]) });
    await reloadMonetization();
    expect(call(world)).toMatchObject({ status: 403, error: 'plan_not_allowed' });

    await ctx.db.update(schema.monetizationHosts).set({ allowedPlanIds: JSON.stringify([other.id, world.planId]) });
    await reloadMonetization();
    expect(call(world)).toMatchObject({ allow: true });

    await ctx.db.update(schema.monetizationConsumers).set({ planId: null });
    await reloadMonetization();
    expect(call(world)).toMatchObject({ status: 403, error: 'no_plan' });
  });

  it('answers 402 with the balance, price, currency and top-up link once the balance runs out', async () => {
    const world = await seed({ price: 4_000, balance: 10_000 });
    expect(call(world)).toMatchObject({ allow: true });
    expect(call(world)).toMatchObject({ allow: true });
    // 2,000 left: a 4,000 request would go below zero with no overdraft.
    expect(call(world)).toEqual({ allow: false, status: 402, error: 'payment_required', balanceMicros: 2_000, priceMicros: 4_000, planId: expect.any(Number), acceptX402: false, consumerId: expect.any(Number) });

    const response = gateResponse(call(world));
    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body).toMatchObject({
      error: 'payment_required',
      balance: '0.002',
      price: '0.004',
      balanceMicros: 2_000,
      priceMicros: 4_000,
      currency: 'USD',
    });
    expect(body.topUpUrl).toMatch(/\/api-portal$/);
    expect(response.headers.get('Link')).toBe(`<${body.topUpUrl}>; rel="payment"`);
  });

  it('lets the balance go down to minus the overdraft allowance and no further', async () => {
    const world = await seed({ price: 1_000, balance: 0, overdraft: 2_500 });
    expect(call(world)).toMatchObject({ allow: true }); // -1000
    expect(call(world)).toMatchObject({ allow: true }); // -2000
    expect(call(world)).toMatchObject({ status: 402, balanceMicros: -2_000 }); // -3000 would pass the cap
    expect(pendingUsage(world.consumerId).chargeMicros).toBe(2_000);
  });

  it('is strictly prepaid with the default allowance of 0', async () => {
    const world = await seed({ price: 1_000, balance: 1_000 });
    expect(call(world)).toMatchObject({ allow: true });
    expect(call(world)).toMatchObject({ status: 402, balanceMicros: 0 });
  });

  it('uses the free monthly requests before the balance, and resets them each month', async () => {
    const world = await seed({ price: 1_000, balance: 1_000, included: 2 });
    expect(call(world)).toMatchObject({ allow: true, free: true, chargedMicros: 0 });
    expect(call(world)).toMatchObject({ allow: true, free: true, chargedMicros: 0 });
    expect(call(world)).toMatchObject({ allow: true, free: false, chargedMicros: 1_000 });
    expect(call(world)).toMatchObject({ status: 402 });

    const nextMonth = Date.UTC(2026, 10, 1, 0, 0, 1);
    expect(call(world, { now: nextMonth })).toMatchObject({ allow: true, free: true });
  });

  it('enforces the per-minute limit with 429 and Retry-After, then lets requests through in the next minute', async () => {
    const world = await seed({ price: 0, perMinute: 2 });
    expect(call(world)).toMatchObject({ allow: true });
    expect(call(world)).toMatchObject({ allow: true });
    const limited = call(world);
    expect(limited).toEqual({ allow: false, status: 429, error: 'rate_limited', retryAfterSeconds: 50, limit: 2 });
    const response = gateResponse(limited);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('50');
    expect((await response.json()).limit).toBe(2);
    // Refused requests are not charged.
    expect(pendingUsage(world.consumerId).requests).toBe(2);
    expect(call(world, { now: T0 + 50_000 })).toMatchObject({ allow: true });
  });

  it('handles a whole HTTP request through the headers Caddy sets', async () => {
    const world = await seed();
    const headers = new Headers({
      'X-Ingressi-Gate-Token': world.token,
      'X-Ingressi-Host-Id': String(world.hostId),
      Authorization: `Bearer ${world.key}`,
    });
    const response = await handleGateRequest(headers, T0);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-ingressi-consumer-id')).toBe(String(world.consumerId));
  });
});

describe('hot path', () => {
  it('makes no database query per request', async () => {
    const world = await seed({ price: 10, balance: 1_000_000, included: 5, perMinute: 1_000 });
    // Whether high availability shared state is on is read once every few
    // seconds, not per request: the first request reads it.
    expect((await handleGateRequest(new Headers({ 'X-Ingressi-Gate-Token': world.token, 'X-Ingressi-Host-Id': String(world.hostId) }), T0)).status).toBe(401);
    // Every statement the database runs, whichever the dialect, and every
    // query builder or transaction asked of the facade.
    const counter = countStatements(ctx.db);
    const spies = [
      vi.spyOn(ctx.db, 'select'),
      vi.spyOn(ctx.db, 'insert'),
      vi.spyOn(ctx.db, 'update'),
      vi.spyOn(ctx.db, 'delete'),
      vi.spyOn(ctx.db, 'transaction'),
    ];
    const headers = new Headers({
      'X-Ingressi-Gate-Token': world.token,
      'X-Ingressi-Host-Id': String(world.hostId),
      Authorization: `Bearer ${world.key}`,
    });
    try {
      for (let i = 0; i < 200; i += 1) {
        expect((await handleGateRequest(headers, T0 + i)).status).toBe(200);
      }
      // Denials too.
      expect((await handleGateRequest(new Headers({ 'X-Ingressi-Gate-Token': world.token, 'X-Ingressi-Host-Id': String(world.hostId) }), T0)).status).toBe(401);
    } finally {
      counter.stop();
    }
    expect(counter.statements).toEqual([]);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(pendingUsage(world.consumerId)).toMatchObject({ requests: 200, chargeMicros: 195 * 10 });
  });
});

describe('flush and reload', () => {
  it('writes usage as one ledger row per consumer and hour, and the balance relative to top-ups made meanwhile', async () => {
    const world = await seed({ price: 1_000, balance: 10_000, included: 1 });
    for (let i = 0; i < 4; i += 1) expect(call(world)).toMatchObject({ allow: true });
    // A top-up arrives before the flush.
    expect((await applyBalanceChange({ consumerId: world.consumerId, type: 'topup', amountMicros: 5_000, reference: 'stripe:cs_test_1', description: null, createdBy: null })).status).toBe('applied');

    const flushed = await flushUsage(T0 + 1_000);
    expect(flushed).toEqual({ consumers: 1, requests: 4, chargedMicros: 3_000 });
    const consumer = (await first(ctx.db.select().from(schema.monetizationConsumers).where(eq(schema.monetizationConsumers.id, world.consumerId)).limit(1)))!;
    expect(consumer.balanceMicros).toBe(10_000 + 5_000 - 3_000);
    expect(consumer.freeUsageMonth).toBe('2026-10');
    expect(consumer.freeUsageCount).toBe(1);
    expect(pendingUsage(world.consumerId)).toMatchObject({ chargeMicros: 0, requests: 0 });

    const usage = async () => await ctx.db.select().from(schema.monetizationLedger).where(eq(schema.monetizationLedger.type, 'usage'));
    expect(await usage()).toHaveLength(1);
    expect((await usage())[0]).toMatchObject({ amountMicros: -3_000, requests: 4, freeRequests: 1, balanceAfterMicros: 12_000 });

    // Same hour: the row is updated in place.
    expect(call(world)).toMatchObject({ allow: true, chargedMicros: 1_000 });
    await flushUsage(T0 + 2_000);
    expect(await usage()).toHaveLength(1);
    expect((await usage())[0]).toMatchObject({ amountMicros: -4_000, requests: 5, freeRequests: 1, balanceAfterMicros: 11_000 });

    // Next hour: a new row.
    expect(call(world, { now: T0 + 3_600_000 })).toMatchObject({ allow: true });
    await flushUsage(T0 + 3_600_000);
    expect(await usage()).toHaveLength(2);

    const key = (await first(ctx.db.select().from(schema.monetizationKeys).limit(1)))!;
    expect(key.lastUsedAt).toBe(new Date(T0 + 3_600_000).toISOString());
    expect(await flushUsage()).toEqual({ consumers: 0, requests: 0, chargedMicros: 0 });
  });

  it('keeps the balance and the free requests used across a restart', async () => {
    const world = await seed({ price: 1_000, balance: 2_000, included: 2 });
    for (let i = 0; i < 3; i += 1) expect(call(world)).toMatchObject({ allow: true });
    await flushUsage(T0);

    resetMonetizationEngineForTests(); // a new process
    await reloadMonetization();
    // Both free requests were used; 1,000 is left.
    expect(call(world)).toMatchObject({ allow: true, free: false, chargedMicros: 1_000 });
    expect(call(world)).toMatchObject({ status: 402, balanceMicros: 0 });
  });

  it('keeps pending usage when an administrator change reloads the state', async () => {
    const world = await seed({ price: 1_000, balance: 2_000 });
    expect(call(world)).toMatchObject({ allow: true });
    await reloadMonetization();
    expect(pendingUsage(world.consumerId).chargeMicros).toBe(1_000);
    expect(call(world)).toMatchObject({ allow: true });
    expect(call(world)).toMatchObject({ status: 402 });
  });

  it('leaves everything pending when the write fails', async () => {
    const world = await seed({ price: 1_000, balance: 5_000 });
    expect(call(world)).toMatchObject({ allow: true });
    vi.spyOn(ctx.db, 'transaction').mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY');
    });
    await expect(flushUsage(T0)).rejects.toThrow('SQLITE_BUSY');
    expect(pendingUsage(world.consumerId).chargeMicros).toBe(1_000);
    expect(await flushUsage(T0)).toMatchObject({ requests: 1 });
  });

  it('runs flushes one at a time, so usage is written once', async () => {
    const world = await seed({ price: 1_000, balance: 10_000 });
    for (let i = 0; i < 3; i += 1) expect(call(world)).toMatchObject({ allow: true });
    // The timer, a shutdown signal and an administrator change can flush together.
    const results = await Promise.all([flushUsage(T0), flushUsage(T0), flushUsage(T0)]);
    expect(results.reduce((sum, result) => sum + result.requests, 0)).toBe(3);
    const consumer = (await first(ctx.db.select().from(schema.monetizationConsumers).where(eq(schema.monetizationConsumers.id, world.consumerId)).limit(1)))!;
    expect(consumer.balanceMicros).toBe(7_000);
    const usage = await ctx.db.select().from(schema.monetizationLedger).where(eq(schema.monetizationLedger.type, 'usage'));
    expect(usage.map((row) => row.requests)).toEqual([3]);
  });

  it('keeps requests counted while a flush is writing pending for the next one', async () => {
    const world = await seed({ price: 1_000, balance: 10_000 });
    expect(call(world)).toMatchObject({ allow: true });
    const flushing = flushUsage(T0);
    // The gate keeps answering while the flush waits for the database.
    expect(call(world)).toMatchObject({ allow: true });
    expect(await flushing).toMatchObject({ requests: 1 });
    expect(pendingUsage(world.consumerId)).toMatchObject({ requests: 1, chargeMicros: 1_000 });
    expect(await flushUsage(T0)).toMatchObject({ requests: 1 });
    expect(pendingUsage(world.consumerId)).toMatchObject({ requests: 0, chargeMicros: 0 });
    const consumer = (await first(ctx.db.select().from(schema.monetizationConsumers).where(eq(schema.monetizationConsumers.id, world.consumerId)).limit(1)))!;
    expect(consumer.balanceMicros).toBe(8_000);
  });

  it('a reload that read before a flush wrote the balance reads it again', async () => {
    const world = await seed({ price: 1_000, balance: 3_000 });
    expect(call(world)).toMatchObject({ allow: true });
    expect(call(world)).toMatchObject({ allow: true });
    // Started together: the reload's reads may run before the flush's write.
    await Promise.all([reloadMonetization(), flushUsage(T0)]);
    expect(pendingUsage(world.consumerId).chargeMicros).toBe(0);
    // 1,000 left: one more request, then payment required.
    expect(call(world)).toMatchObject({ allow: true });
    expect(call(world)).toMatchObject({ status: 402 });
  });

  it('drops the counts of a consumer deleted before the flush', async () => {
    const world = await seed({ price: 1_000, balance: 5_000 });
    expect(call(world)).toMatchObject({ allow: true });
    await ctx.db.delete(schema.monetizationConsumers);
    expect(await flushUsage(T0)).toMatchObject({ requests: 1 });
    expect(await ctx.db.select().from(schema.monetizationLedger)).toHaveLength(0);
  });
});
