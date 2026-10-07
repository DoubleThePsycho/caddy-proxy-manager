/**
 * Ranges, buckets and the previous period, and how queryAnalytics assembles
 * ClickHouse rows into series, headline numbers and peaks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ch = vi.hoisted(() => ({
  retention: 30,
  handler: (() => []) as (query: string, params: Record<string, unknown>) => unknown[],
}));

vi.mock('@/src/lib/clickhouse/client', () => ({
  isAnalyticsEnabled: () => true,
  getRetentionDays: () => ch.retention,
  getClient: () => ({
    query: async ({ query, query_params }: { query: string; query_params: Record<string, unknown> }) => ({
      json: async () => ch.handler(query, query_params),
    }),
  }),
}));

import { previousPeriod, resolveRange, sparklineStep } from '@/src/lib/analytics/range';
import { parseAnalyticsQuery, queryAnalytics } from '@/src/lib/analytics/query';
import { findBursts } from '@/src/lib/analytics/signals';
import { ApiValidationError } from '@/src/lib/api-errors';

// 2026-10-03 11:36:40 UTC
const NOW = 1_791_027_400;

beforeEach(() => {
  ch.retention = 30;
  ch.handler = () => [];
});

describe('resolveRange', () => {
  it.each([
    ['1h', 60, 60],
    ['24h', 1800, 48],
    ['7d', 10_800, 56],
    ['30d', 86_400, 30],
  ])('%s has a %is step and %i buckets ending with the one holding now', (range, step, buckets) => {
    const r = resolveRange({ range }, NOW);
    expect(r.step).toBe(step);
    expect(r.buckets).toBe(buckets);
    expect(r.end % step).toBe(0);
    expect(r.end - step).toBeLessThanOrEqual(NOW);
    expect(r.end).toBeGreaterThan(NOW);
    expect(r.start).toBe(r.end - buckets * step);
  });

  it('defaults to the fallback preset', () => {
    expect(resolveRange({}, NOW).preset).toBe('24h');
    expect(resolveRange({}, NOW, '7d').preset).toBe('7d');
  });

  it('cuts a custom range into about 60 aligned buckets', () => {
    const r = resolveRange({ from: String(NOW - 6 * 3600), to: String(NOW) }, NOW);
    expect(r.preset).toBe('custom');
    expect(r.step).toBe(600);
    expect(r.start % 600).toBe(0);
    expect(r.end % 600).toBe(0);
    expect(r.buckets).toBe((r.end - r.start) / 600);
    expect(resolveRange({ range: 'custom', from: NOW - 50 * 86_400, to: NOW }, NOW).step).toBe(86_400);
  });

  it.each([
    [{ from: NOW - 100 }],
    [{ to: NOW }],
    [{ range: '24h', from: NOW - 100, to: NOW }],
    [{ from: NOW, to: NOW - 1 }],
    [{ from: NOW - 100 * 86_400, to: NOW }],
    [{ from: NOW + 3600, to: NOW + 7200 }],
    [{ from: 'yesterday', to: NOW }],
    [{ range: 'custom' }],
    [{ range: '90d' }],
  ])('refuses %j', (input) => {
    expect(() => resolveRange(input, NOW)).toThrow(ApiValidationError);
  });

  it('makes sparklines of about 24 points', () => {
    expect(sparklineStep(resolveRange({ range: '24h' }, NOW))).toBe(3600);
    expect(sparklineStep(resolveRange({ range: '7d' }, NOW))).toBe(43_200);
  });
});

describe('previousPeriod', () => {
  it('is the same length right before the range', () => {
    const range = resolveRange({ range: '7d' }, NOW);
    expect(previousPeriod(range, NOW)).toEqual({ available: true, start: range.start - 7 * 86_400, end: range.start });
  });

  it('is unavailable when any of it is older than the retention window', () => {
    const range = resolveRange({ range: '30d' }, NOW);
    expect(previousPeriod(range, NOW)).toMatchObject({ available: false, reason: 'retention' });
    ch.retention = 90;
    expect(previousPeriod(range, NOW).available).toBe(true);
  });
});

describe('queryAnalytics', () => {
  it('splits rows into the previous and current period and builds the headline', async () => {
    const query = parseAnalyticsQuery({ range: '24h' }, NOW);
    const n = query.range.buckets;
    ch.handler = (sql) => {
      if (sql.includes('AS g')) {
        return [
          { b: 0, g: 'served', v: '10' },
          { b: n + 1, g: 'served', v: '30' },
          { b: n + 1, g: 'waf', v: '4' },
          { b: n + 5, g: 'geo', v: '9' },
          { b: 2 * n + 3, g: 'served', v: '1' }, // outside the window: ignored
        ];
      }
      if (sql.includes('uniqIf')) return [{ visitors: '7', p_visitors: '2' }];
      return [
        { b: 0, requests: '10', bytes: '1000', visitors: '2', mitigated: '0', e5: '1' },
        { b: n + 1, requests: '34', bytes: '3000', visitors: '5', mitigated: '4', e5: '2' },
        { b: n + 5, requests: '9', bytes: '90', visitors: '1', mitigated: '9', e5: '0' },
      ];
    };
    const result = await queryAnalytics(query, NOW);
    expect(result.status).toBe('ok');
    expect(result.series.map((s) => s.key)).toEqual(['served', 'waf', 'geo']);
    expect(result.series[0].values[1]).toBe(30);
    expect(result.series[0].total).toBe(30);
    expect(result.totals[1]).toBe(34);
    expect(result.totals[5]).toBe(9);
    expect(result.previous.available).toBe(true);
    if (result.previous.available) {
      expect(result.previous.series.find((s) => s.key === 'served')!.values[0]).toBe(10);
      expect(result.previous.totals[0]).toBe(10);
    }
    expect(result.headline.requests).toEqual({ value: 43, previous: 10, delta: 3.3 });
    expect(result.headline.bytes.value).toBe(3090);
    expect(result.headline.visitors).toEqual({ value: 7, previous: 2, delta: 2.5 });
    expect(result.headline.mitigated).toMatchObject({ value: 13, previous: 0, delta: null, share: 13 / 43 });
    expect(result.headline.errorRate5xx.count).toBe(2);
    expect(result.headline.errorRate5xx.value).toBeCloseTo(2 / 43);
    expect(result.headline.errorRate5xx.delta).toBeCloseTo((2 / 43) / (1 / 10) - 1);
    expect(result.peak).toEqual({ index: 1, ts: query.range.start + query.range.step, value: 34 });
    expect(result.peakMitigated).toEqual({ index: 5, ts: query.range.start + 5 * query.range.step, value: 9 });
    expect(result.retention.days).toBe(30);
  });

  it('has no previous period for 30 days with 30-day retention, and says why', async () => {
    const result = await queryAnalytics(parseAnalyticsQuery({ range: '30d' }, NOW), NOW);
    expect(result.previous).toMatchObject({ available: false, reason: 'retention' });
    expect(result.headline.requests.previous).toBeNull();
    expect(result.headline.requests.delta).toBeNull();
  });

  it('puts the busiest hosts first and every other host last', async () => {
    const query = parseAnalyticsQuery({ range: '1h', groupBy: 'host', topHosts: 2 }, NOW);
    ch.handler = (sql) => {
      if (sql.includes('LIMIT {p_top:UInt32}')) return [{ g: 'b.example.com' }, { g: 'a.example.com' }];
      if (sql.includes('AS g')) {
        return [
          { b: 60, g: '__other__', v: '50' },
          { b: 61, g: 'a.example.com', v: '5' },
          { b: 62, g: 'b.example.com', v: '9' },
        ];
      }
      return [];
    };
    const result = await queryAnalytics(query, NOW);
    expect(result.series.map((s) => [s.key, s.label])).toEqual([
      ['b.example.com', 'b.example.com'],
      ['a.example.com', 'a.example.com'],
      ['__other__', 'Other hosts'],
    ]);
  });
});

describe('findBursts', () => {
  const minute = (m: number, total: number, e5: number, host = 'mail.example.com') => ({ host, m: NOW + m * 60, total, e5 });

  it('joins minutes with 5xx into runs and keeps the ones that qualify', () => {
    const bursts = findBursts([
      minute(0, 100, 60),
      minute(1, 100, 50),
      minute(3, 100, 33), // two-minute gap: same run
      minute(30, 100, 5), // new run: too few
      minute(0, 10_000, 20, 'busy.example.com'), // 0.2%: not a burst
    ]);
    expect(bursts).toEqual([{ host: 'mail.example.com', start: NOW, end: NOW + 180, count: 143, requests: 300 }]);
  });
});
