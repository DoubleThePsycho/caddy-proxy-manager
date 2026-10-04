/**
 * API monetization options (ee/monetization/options.ts) and history
 * retention (retention.ts): the REST endpoint, the license on changes
 * (turning replica serving off needs none), validation, the audit record,
 * and the leader's pruning of hourly usage and credit history older than
 * the retention while money moved (top-ups, payments, adjustments) stays.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { installLicense, licenseSigner } from '../helpers/config-fixture';
import { insertConsumer } from '../helpers/monetization';
import { eq } from 'drizzle-orm';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('../../src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-auth')>();
  const { adminAccess } = await import('../../src/lib/permissions');
  return { ...actual, requireApiPermission: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer', access: adminAccess(1) }) };
});

import { logAuditEvent } from '../../src/lib/audit';
import { setTrustedLicenseKeysForTests } from '../../ee/licensing/public-keys';
import { pruneMonetizationHistory } from '../../ee/monetization/retention';
import { resetMonetizationEngineForTests } from '../../ee/monetization/engine';
import * as settingsRoute from '../../app/api/v1/monetization/settings/route';

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/v1/monetization/settings', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function ledgerRow(consumerId: number, type: string, createdAt: string, reference: string | null = null) {
  await ctx.db.insert(schema.monetizationLedger).values({
    consumerId,
    type,
    amountMicros: type === 'usage' ? -1_000 : 1_000,
    balanceAfterMicros: 0,
    requests: type === 'usage' || type === 'credit' ? 1 : 0,
    externalReference: reference,
    createdAt,
    updatedAt: createdAt,
  });
}

beforeEach(async () => {
  ctx.db = createTestDb();
  resetMonetizationEngineForTests();
  vi.mocked(logAuditEvent).mockClear();
  setTrustedLicenseKeysForTests(licenseSigner.keys);
  await installLicense(ctx.db, 'enterprise');
});

afterAll(() => setTrustedLicenseKeysForTests(null));

describe('options', () => {
  it('default to 13 months and no replica serving', async () => {
    const response = await settingsRoute.GET(req('GET'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ usageRetentionMonths: 13, replicas: { mode: 'off', gateUrl: null, problem: null } });
  });

  it('change with the license, are audited, and are validated', async () => {
    const saved = await settingsRoute.PUT(req('PUT', { usageRetentionMonths: 6, replicas: { mode: 'allowance', gateUrl: 'https://dash.example.com/' } }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ usageRetentionMonths: 6, replicas: { mode: 'allowance', gateUrl: 'https://dash.example.com' } });
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'monetization_options', action: 'update' }));
    for (const body of [
      { usageRetentionMonths: 0 },
      { usageRetentionMonths: 121 },
      { replicas: { mode: 'everywhere' } },
      { replicas: { mode: 'allowance', gateUrl: 'http://dash.example.com' } },
      { replicas: { mode: 'allowance', gateUrl: 'https://user:pw@dash.example.com' } },
      { replicas: { mode: 'shared' } },
      { other: true },
    ]) {
      expect((await settingsRoute.PUT(req('PUT', body))).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('need the license to change, except turning replica serving off', async () => {
    await settingsRoute.PUT(req('PUT', { replicas: { mode: 'allowance' } }));
    await ctx.db.delete(schema.settings).where(eq(schema.settings.key, 'license'));
    expect((await settingsRoute.PUT(req('PUT', { usageRetentionMonths: 24 }))).status).toBe(403);
    expect((await settingsRoute.PUT(req('PUT', { replicas: { mode: 'allowance', gateUrl: 'https://other.example.com' } }))).status).toBe(403);
    const off = await settingsRoute.PUT(req('PUT', { replicas: { mode: 'off' } }));
    expect(off.status).toBe(200);
    expect((await off.json()).replicas.mode).toBe('off');
  });
});

describe('retention', () => {
  it('deletes hourly usage and credit history older than the retention and keeps money moved', async () => {
    const consumer = await insertConsumer(ctx.db, { balanceMicros: 42 });
    const old = new Date(Date.UTC(2025, 5, 1)).toISOString();
    const recent = new Date(Date.UTC(2026, 8, 1)).toISOString();
    await ledgerRow(consumer.id, 'usage', old, 'usage:1:2025-06-01T00');
    await ledgerRow(consumer.id, 'credit', old, 'answer-credit:1:2025-06-01T00');
    await ledgerRow(consumer.id, 'topup', old, 'stripe:cs_old');
    await ledgerRow(consumer.id, 'payment', old, 'stripe-pi:pi_old');
    await ledgerRow(consumer.id, 'adjustment', old);
    await ledgerRow(consumer.id, 'usage', recent, 'usage:1:2026-09-01T00');
    await ctx.db.insert(schema.monetizationAnswerCredits).values({ chargeId: 'c1.old', consumerId: consumer.id, amountMicros: 1, free: false, createdAt: old });
    await ctx.db.insert(schema.monetizationAnswerCredits).values({ chargeId: 'c1.new', consumerId: consumer.id, amountMicros: 1, free: false, createdAt: new Date(NOW).toISOString() });

    const result = await pruneMonetizationHistory(NOW);
    expect(result).toEqual({ ledgerRows: 2, answerCredits: 1, cutoff: '2025-09-04T12:00:00.000Z' });
    const left = await ctx.db.select().from(schema.monetizationLedger);
    expect(left.map((row) => row.type).sort()).toEqual(['adjustment', 'payment', 'topup', 'usage']);
    expect(left.find((row) => row.type === 'usage')?.createdAt).toBe(recent);
    expect((await ctx.db.select().from(schema.monetizationConsumers))[0].balanceMicros).toBe(42);
    expect((await ctx.db.select().from(schema.monetizationAnswerCredits)).map((row) => row.chargeId)).toEqual(['c1.new']);

    // A shorter retention prunes more.
    await settingsRoute.PUT(req('PUT', { usageRetentionMonths: 1 }));
    expect(await pruneMonetizationHistory(NOW)).toMatchObject({ ledgerRows: 1 });
  });
});
