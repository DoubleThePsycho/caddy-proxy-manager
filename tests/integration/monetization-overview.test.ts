/**
 * The API monetization overview against a real SQLite ledger
 * (ee/monetization/overview.ts) and its endpoint
 * GET /api/v1/monetization/overview: UTC months and days from createdAt,
 * charged versus free requests, top consumers, key use, balances, the last
 * top-up, the monetization:read guard and no license needed to read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { insertConsumer, insertKey, insertPlan } from '../helpers/monetization';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

vi.mock('../../src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-auth')>();
  return { ...actual, requireApiPermission: vi.fn() };
});

import { ApiAuthError, requireApiPermission } from '../../src/lib/api-auth';
import { resetMonetizationEngineForTests } from '../../ee/monetization/engine';
import { getMonetizationOverview } from '../../ee/monetization/overview';
import * as overviewRoute from '../../app/api/v1/monetization/overview/route';

const NOW = new Date('2026-10-03T11:36:00.000Z');

async function ledger(values: Partial<typeof schema.monetizationLedger.$inferInsert> & { consumerId: number; type: string; createdAt: string }) {
  await ctx.db
    .insert(schema.monetizationLedger)
    .values({ amountMicros: 0, balanceAfterMicros: 0, updatedAt: values.createdAt, ...values });
}

async function seed() {
  const plan = await insertPlan(ctx.db, { name: 'Standard', includedRequestsPerMonth: 100 });
  const acme = await insertConsumer(ctx.db, { name: 'Acme', planId: plan.id, balanceMicros: 5_000_000 });
  const beta = await insertConsumer(ctx.db, { name: 'Beta', planId: plan.id, status: 'disabled', balanceMicros: 1_000_000 });
  const gamma = await insertConsumer(ctx.db, { name: 'Gamma', planId: plan.id, balanceMicros: -500, overdraftAllowanceMicros: 1_000 });
  const delta = await insertConsumer(ctx.db, { name: 'Delta', planId: plan.id });

  await ledger({ consumerId: acme.id, type: 'usage', amountMicros: -2_000, requests: 10, freeRequests: 2, externalReference: `usage:${acme.id}:2026-10-02T10`, createdAt: '2026-10-02T10:00:04.000Z' });
  await ledger({ consumerId: acme.id, type: 'usage', amountMicros: -5_000, requests: 5, externalReference: `usage:${acme.id}:2026-10-03T09`, createdAt: '2026-10-03T09:00:01.000Z' });
  await ledger({ consumerId: beta.id, type: 'usage', requests: 3, freeRequests: 3, externalReference: `usage:${beta.id}:2026-10-01T00`, createdAt: '2026-10-01T00:05:00.000Z' });
  await ledger({ consumerId: acme.id, type: 'topup', amountMicros: 10_000_000, externalReference: 'stripe:cs_test_2', createdAt: '2026-10-01T12:00:00.000Z' });
  await ledger({ consumerId: acme.id, type: 'adjustment', amountMicros: -1_000_000, description: 'Refund', createdAt: '2026-10-02T08:00:00.000Z' });
  await ledger({ consumerId: gamma.id, type: 'topup', amountMicros: 25_000_000, externalReference: 'stripe:cs_test_1', createdAt: '2026-09-15T08:00:00.000Z' });
  await ledger({ consumerId: acme.id, type: 'usage', amountMicros: -100_000, requests: 100, externalReference: `usage:${acme.id}:2026-09-15T08`, createdAt: '2026-09-15T08:00:00.000Z' });
  // Before the previous month and outside the 30 days: left out.
  await ledger({ consumerId: acme.id, type: 'usage', amountMicros: -7, requests: 7, externalReference: `usage:${acme.id}:2026-08-20T08`, createdAt: '2026-08-20T08:00:00.000Z' });
  // After the moment the overview is taken for (tomorrow, UTC): left out.
  await ledger({ consumerId: acme.id, type: 'usage', amountMicros: -9, requests: 9, externalReference: `usage:${acme.id}:2026-10-04T00`, createdAt: '2026-10-04T00:00:00.000Z' });

  await insertKey(ctx.db, acme.id, { lastUsedAt: '2026-10-03T09:30:00.000Z' });
  await insertKey(ctx.db, beta.id, { revokedAt: '2026-09-27T08:00:00.000Z' });
  return { acme, beta, gamma, delta };
}

beforeEach(() => {
  ctx.db = createTestDb();
  resetMonetizationEngineForTests();
  vi.mocked(requireApiPermission).mockReset();
  vi.mocked(requireApiPermission).mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' } as never);
});

describe('monetization overview', () => {
  it('computes month totals, days, top consumers and balances from the ledger', async () => {
    const { acme, beta, gamma, delta } = await seed();
    const overview = await getMonetizationOverview({ now: NOW });

    expect(overview.currency).toBe('usd');
    expect(overview.generatedAt).toBe(NOW.toISOString());
    expect(overview.thisMonth).toEqual({
      month: '2026-10-01',
      paidInMicros: 10_000_000,
      topUps: 1,
      payments: 0,
      refundedMicros: 0,
      chargedMicros: 7_000,
      creditedMicros: 0,
      creditedRequests: 0,
      requests: 18,
      chargedRequests: 13,
      freeRequests: 5,
      adjustmentsMicros: -1_000_000,
      adjustments: 1,
    });
    expect(overview.previousMonth).toMatchObject({ month: '2026-09-01', paidInMicros: 25_000_000, topUps: 1, chargedMicros: 100_000, requests: 100 });

    expect(overview.days).toHaveLength(30);
    expect(overview.days[0].day).toBe('2026-09-04');
    expect(overview.days.find((day) => day.day === '2026-10-02')).toMatchObject({ requests: 10, chargedRequests: 8, freeRequests: 2, chargedMicros: 2_000 });
    expect(overview.days.find((day) => day.day === '2026-09-15')).toMatchObject({ requests: 100, paidInMicros: 25_000_000 });
    expect(overview.days.at(-1)).toMatchObject({ day: '2026-10-03', requests: 5, chargedMicros: 5_000 });

    expect(overview.topConsumers.map((top) => [top.name, top.requests, top.chargedMicros])).toEqual([
      ['Acme', 15, 7_000],
      ['Beta', 3, 0],
    ]);
    expect(overview.topConsumers[0].share).toBeCloseTo(15 / 18);

    const usage = new Map(overview.consumers.map((item) => [item.consumerId, item]));
    expect(usage.get(acme.id)).toMatchObject({ requests: 15, keysLastUsedAt: '2026-10-03T09:30:00.000Z', funded: true });
    expect(usage.get(beta.id)).toMatchObject({ requests: 3, freeRequests: 3, revokedKeys: 1, lastRevokedAt: '2026-09-27T08:00:00.000Z', funded: false });
    expect(usage.get(gamma.id)).toMatchObject({ requests: 0, funded: true });
    expect(usage.has(delta.id)).toBe(false);

    expect(overview.balances).toEqual({
      consumers: 4,
      heldMicros: 6_000_000,
      heldFor: 2,
      heldForDisabled: 1,
      overdrawnMicros: 500,
      overdrawn: 1,
      postpaidOpenMicros: 0,
      postpaidOpen: 0,
    });
    expect(overview.lastTopUp).toEqual({ consumerId: acme.id, consumerName: 'Acme', amountMicros: 10_000_000, at: '2026-10-01T12:00:00.000Z' });
  });

  it('names a deleted consumer null and starts empty on a fresh install', async () => {
    const empty = await getMonetizationOverview({ now: NOW });
    expect(empty.thisMonth.requests).toBe(0);
    expect(empty.topConsumers).toEqual([]);
    expect(empty.lastTopUp).toBeNull();
    expect(empty.days.every((day) => day.requests === 0 && day.chargedMicros === 0)).toBe(true);

    await ledger({ consumerId: 99, type: 'usage', amountMicros: -1_000, requests: 1, externalReference: 'usage:99:2026-10-03T08', createdAt: '2026-10-03T08:00:00.000Z' });
    const overview = await getMonetizationOverview({ now: NOW });
    expect(overview.topConsumers).toEqual([{ consumerId: 99, name: null, planName: null, requests: 1, chargedMicros: 1_000, share: 1 }]);
  });
});

describe('GET /api/v1/monetization/overview', () => {
  const request = () => new NextRequest('http://localhost/api/v1/monetization/overview');

  it('answers with the overview under monetization:read, without a license and without caching', async () => {
    const acme = await insertConsumer(ctx.db, { name: 'Acme' });
    const today = new Date().toISOString();
    await ledger({ consumerId: acme.id, type: 'usage', amountMicros: -3_000, requests: 3, externalReference: `usage:${acme.id}:now`, createdAt: today });

    const response = await overviewRoute.GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(vi.mocked(requireApiPermission)).toHaveBeenCalledWith(expect.anything(), 'monetization:read');
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(['balances', 'consumers', 'currency', 'days', 'generatedAt', 'lastTopUp', 'previousMonth', 'thisMonth', 'topConsumers', 'x402']);
    expect(body.days).toHaveLength(30);
    expect(body.days.at(-1)).toMatchObject({ day: today.slice(0, 10), requests: 3, chargedMicros: 3_000 });
    expect(JSON.stringify(body)).not.toMatch(/keyHash|portalToken/);
  });

  it('refuses callers without the permission', async () => {
    vi.mocked(requireApiPermission).mockRejectedValueOnce(new ApiAuthError('Forbidden', 403));
    const response = await overviewRoute.GET(request());
    expect(response.status).toBe(403);
  });
});
