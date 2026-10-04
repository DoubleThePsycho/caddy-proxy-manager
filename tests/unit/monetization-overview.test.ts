/**
 * The API monetization overview's arithmetic (ee/monetization/overview-summary.ts)
 * and the exact money display (ee/monetization/money.ts): UTC month and day
 * boundaries, charged versus free requests, month totals against the
 * previous month, top consumers, balances held, and amounts that are never
 * rounded through floating point.
 */
import { describe, expect, it } from 'vitest';
import { overviewPeriods, summarizeOverview, type DailyAggregate, type OverviewInputs } from '@/ee/monetization/overview-summary';
import { decimalsFor, formatMoney } from '@/ee/monetization/money';
import type { ConsumerView } from '@/ee/monetization/types';

const NOW = new Date('2026-10-03T11:36:00.000Z');
const stamp = '2026-10-01T00:00:00.000Z';

function consumer(id: number, values: Partial<ConsumerView> = {}): ConsumerView {
  return {
    id,
    name: `Consumer ${id}`,
    email: null,
    status: 'active',
    planId: 1,
    planName: 'Standard',
    balanceMicros: 0,
    overdraftAllowanceMicros: 0,
    includedRequestsUsed: 0,
    hasPortalLink: false,
    activeKeyCount: 0,
    billingOverride: null,
    billing: 'prepaid',
    postpaid: null,
    createdAt: stamp,
    updatedAt: stamp,
    ...values,
  };
}

function inputs(values: Partial<OverviewInputs> = {}): OverviewInputs {
  return { now: NOW, currency: 'eur', daily: [], consumerUsage: [], keys: [], funded: new Set(), consumers: [], lastTopUp: null, ...values };
}

const usage = (day: string, amountMicros: number, requests: number, freeRequests: number, entries = 1): DailyAggregate => ({
  day,
  type: 'usage',
  amountMicros,
  requests,
  freeRequests,
  entries,
});

describe('overview periods', () => {
  it('covers this month, the previous one and the last 30 UTC days up to today', () => {
    const periods = overviewPeriods(NOW);
    expect(periods.monthStart).toBe('2026-10-01T00:00:00.000Z');
    expect(periods.previousMonthStart).toBe('2026-09-01T00:00:00.000Z');
    expect(periods.windowStart).toBe('2026-09-04T00:00:00.000Z');
    expect(periods.end).toBe('2026-10-04T00:00:00.000Z');
    expect(periods.days).toHaveLength(30);
    expect(periods.days[0]).toBe('2026-09-04');
    expect(periods.days[29]).toBe('2026-10-03');
  });

  it('rolls the previous month over the new year', () => {
    const periods = overviewPeriods(new Date('2027-01-15T23:59:59.999Z'));
    expect(periods.monthStart).toBe('2027-01-01T00:00:00.000Z');
    expect(periods.previousMonthStart).toBe('2026-12-01T00:00:00.000Z');
    expect(periods.days[29]).toBe('2027-01-15');
  });
});

describe('overview totals', () => {
  it('splits charged and free requests and sums money per month and per day', () => {
    const overview = summarizeOverview(
      inputs({
        daily: [
          usage('2026-10-02', -2_000_000, 500, 20, 3),
          { day: '2026-10-01', type: 'topup', amountMicros: 10_000_000, requests: 0, freeRequests: 0, entries: 1 },
          { day: '2026-10-01', type: 'adjustment', amountMicros: -1_000_000, requests: 0, freeRequests: 0, entries: 1 },
          usage('2026-09-20', -5_000_000, 1_000, 0),
          { day: '2026-09-20', type: 'topup', amountMicros: 25_000_000, requests: 0, freeRequests: 0, entries: 2 },
          // In the previous month but before the 30-day window.
          usage('2026-09-02', -1, 1, 0),
          // Before the previous month: in neither.
          usage('2026-08-31', -7, 7, 0),
        ],
      })
    );
    expect(overview.thisMonth).toEqual({
      month: '2026-10-01',
      paidInMicros: 10_000_000,
      topUps: 1,
      payments: 0,
      refundedMicros: 0,
      chargedMicros: 2_000_000,
      creditedMicros: 0,
      creditedRequests: 0,
      requests: 500,
      chargedRequests: 480,
      freeRequests: 20,
      adjustmentsMicros: -1_000_000,
      adjustments: 1,
    });
    expect(overview.previousMonth).toMatchObject({ month: '2026-09-01', paidInMicros: 25_000_000, topUps: 2, chargedMicros: 5_000_001, requests: 1_001 });
    expect(overview.days).toHaveLength(30);
    expect(overview.days.find((day) => day.day === '2026-10-02')).toEqual({
      day: '2026-10-02',
      requests: 500,
      chargedRequests: 480,
      freeRequests: 20,
      chargedMicros: 2_000_000,
      paidInMicros: 0,
    });
    expect(overview.days.find((day) => day.day === '2026-09-20')?.paidInMicros).toBe(25_000_000);
    expect(overview.days.some((day) => day.day === '2026-09-02' || day.day === '2026-08-31')).toBe(false);
    expect(overview.days.at(-1)).toMatchObject({ day: '2026-10-03', requests: 0 });
  });

  it('keeps sub-cent amounts exact however many there are', () => {
    // 0.0001 EUR a thousand times is 0.1 EUR exactly, which floating point 0.1 + 0.2 style sums would not be.
    const daily = Array.from({ length: 1_000 }, (_, i) => usage(i % 2 ? '2026-10-01' : '2026-10-02', -100, 1, 0));
    const overview = summarizeOverview(inputs({ daily }));
    expect(overview.thisMonth.chargedMicros).toBe(100_000);
    expect(formatMoney(overview.thisMonth.chargedMicros, 'eur')).toBe('€0.10');
  });

  it('ranks this month’s top consumers by metered requests, with their share and charge', () => {
    const consumers = [consumer(1, { name: 'Acme', planName: 'Partner' }), consumer(2, { name: 'Beta' }), consumer(3, { name: 'Gamma' })];
    const overview = summarizeOverview(
      inputs({
        daily: [usage('2026-10-02', -9_000, 90, 10)],
        consumerUsage: [
          { consumerId: 2, type: 'usage', amountMicros: -2_000, requests: 20, freeRequests: 0 },
          { consumerId: 1, type: 'usage', amountMicros: -6_000, requests: 60, freeRequests: 10 },
          { consumerId: 9, type: 'usage', amountMicros: -1_000, requests: 20, freeRequests: 0 },
          { consumerId: 3, type: 'usage', amountMicros: 0, requests: 0, freeRequests: 0 },
        ],
        consumers,
      })
    );
    expect(overview.topConsumers.map((top) => [top.consumerId, top.name, top.requests, top.chargedMicros])).toEqual([
      [1, 'Acme', 60, 6_000],
      [2, 'Beta', 20, 2_000],
      [9, null, 20, 1_000],
    ]);
    expect(overview.topConsumers[0].planName).toBe('Partner');
    expect(overview.topConsumers[0].share).toBeCloseTo(60 / 90);
    const acme = overview.consumers.find((item) => item.consumerId === 1);
    expect(acme).toMatchObject({ requests: 60, chargedRequests: 50, freeRequests: 10, chargedMicros: 6_000 });
  });

  it('lists at most five top consumers', () => {
    const consumerUsage = Array.from({ length: 8 }, (_, i) => ({ consumerId: i + 1, type: 'usage', amountMicros: -(i + 1), requests: i + 1, freeRequests: 0 }));
    expect(summarizeOverview(inputs({ consumerUsage })).topConsumers.map((top) => top.consumerId)).toEqual([8, 7, 6, 5, 4]);
  });

  it('sums the balances held and the overdrafts apart', () => {
    const overview = summarizeOverview(
      inputs({
        consumers: [
          consumer(1, { balanceMicros: 5_000_000 }),
          consumer(2, { balanceMicros: 1_000_000, status: 'disabled' }),
          consumer(3, { balanceMicros: -500 }),
          consumer(4, { balanceMicros: 0 }),
        ],
      })
    );
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
  });

  it('merges key use and funding into the per-consumer usage', () => {
    const overview = summarizeOverview(
      inputs({
        keys: [
          { consumerId: 1, lastUsedAt: '2026-10-03T09:30:00.000Z', revoked: 0, lastRevokedAt: null },
          { consumerId: 2, lastUsedAt: null, revoked: 1, lastRevokedAt: '2026-09-27T08:00:00.000Z' },
        ],
        funded: new Set([1, 3]),
      })
    );
    expect(overview.consumers).toEqual([
      { consumerId: 1, requests: 0, chargedRequests: 0, freeRequests: 0, chargedMicros: 0, keysLastUsedAt: '2026-10-03T09:30:00.000Z', revokedKeys: 0, lastRevokedAt: null, funded: true },
      { consumerId: 2, requests: 0, chargedRequests: 0, freeRequests: 0, chargedMicros: 0, keysLastUsedAt: null, revokedKeys: 1, lastRevokedAt: '2026-09-27T08:00:00.000Z', funded: false },
      { consumerId: 3, requests: 0, chargedRequests: 0, freeRequests: 0, chargedMicros: 0, keysLastUsedAt: null, revokedKeys: 0, lastRevokedAt: null, funded: true },
    ]);
    expect(overview.topConsumers).toEqual([]);
  });
});

describe('money display', () => {
  it('shows amounts exactly with the currency symbol', () => {
    expect(formatMoney(12_500_000, 'eur')).toBe('€12.50');
    expect(formatMoney(-1_000, 'eur')).toBe('-€0.001');
    expect(formatMoney(500, 'usd')).toBe('$0.0005');
    expect(formatMoney(0, 'usd')).toBe('$0.00');
    expect(formatMoney(1_234_567_890_123, 'usd')).toBe('$1,234,567.890123');
    expect(formatMoney(1_000_000_000, 'jpy')).toBe('¥1,000');
  });

  it('falls back to the code for a currency without a symbol', () => {
    expect(formatMoney(12_500_000, 'xyz')).toBe('12.50 XYZ');
  });

  it('lines a column of prices up on the decimals the most precise one needs', () => {
    const prices = [10_000, 6_000, 4_000];
    const decimals = decimalsFor(prices, 'eur');
    expect(decimals).toBe(3);
    expect(prices.map((micros) => formatMoney(micros, 'eur', { decimals }))).toEqual(['€0.010', '€0.006', '€0.004']);
    expect(decimalsFor([10_000_000], 'eur')).toBe(2);
    expect(formatMoney(10_000, 'eur', { decimals: 4 })).toBe('€0.0100');
  });
});

describe('phase 2 entries', () => {
  it('nets failed-answer credits off what was charged, counts postpaid payments as paid in, and refunds apart', () => {
    const overview = summarizeOverview(
      inputs({
        daily: [
          usage('2026-10-02', -5_000_000, 100, 0),
          { day: '2026-10-02', type: 'credit', amountMicros: 250_000, requests: 5, freeRequests: 0, entries: 1 },
          { day: '2026-10-02', type: 'payment', amountMicros: 4_000_000, requests: 0, freeRequests: 0, entries: 2 },
          { day: '2026-10-02', type: 'refund', amountMicros: -1_000_000, requests: 0, freeRequests: 0, entries: 1 },
          { day: '2026-10-02', type: 'dispute', amountMicros: -500_000, requests: 0, freeRequests: 0, entries: 1 },
        ],
        consumerUsage: [
          { consumerId: 7, type: 'usage', amountMicros: -5_000_000, requests: 100, freeRequests: 0 },
          { consumerId: 7, type: 'credit', amountMicros: 250_000, requests: 5, freeRequests: 0 },
        ],
      })
    );
    expect(overview.thisMonth).toMatchObject({
      chargedMicros: 4_750_000,
      creditedMicros: 250_000,
      creditedRequests: 5,
      requests: 100,
      paidInMicros: 4_000_000,
      payments: 2,
      topUps: 0,
      refundedMicros: 1_500_000,
    });
    expect(overview.days.find((day) => day.day === '2026-10-02')).toMatchObject({ chargedMicros: 4_750_000, paidInMicros: 4_000_000 });
    expect(overview.consumers.find((item) => item.consumerId === 7)?.chargedMicros).toBe(4_750_000);
  });

  it('counts what postpaid consumers owe apart from prepaid overdrafts', () => {
    const owing = consumer(1, { balanceMicros: -3_000_000, billing: 'postpaid' });
    const overdrawn = consumer(2, { balanceMicros: -200 });
    const overview = summarizeOverview(inputs({ consumers: [owing, overdrawn] }));
    expect(overview.balances).toMatchObject({ overdrawnMicros: 200, overdrawn: 1, postpaidOpenMicros: 3_000_000, postpaidOpen: 1 });
  });
});
