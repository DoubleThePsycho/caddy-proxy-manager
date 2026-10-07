/**
 * The analytics query: one metric over a range, split into buckets and
 * grouped, with the previous period, the five headline numbers and their
 * change, and the peak bucket. Filters, metric and grouping come from the
 * allow-lists in dimensions.ts; every value is a bound parameter.
 */
import { ApiValidationError } from '../api-errors';
import { getRetentionDays } from '../clickhouse/client';
import {
  DIMENSION_SPECS,
  METRIC_SQL,
  MITIGATED_SQL,
  OTHER_HOSTS,
  OUTCOME_SQL,
  STATUS_CLASS_SQL,
  parseGrouping,
  parseMetric,
  type Grouping,
  type Metric,
} from './dimensions';
import { buildFilterSql, parseFilters, type AnalyticsFilter } from './filters';
import { OUTCOMES, type Outcome } from './outcome';
import { previousPeriod, resolveRange, retentionStart, type RangePreset, type ResolvedRange } from './range';
import { delta, num, ratio, selectRows, withAnalytics, type AnalyticsStatus, type QueryParams } from './run';
import { scopeSql, type HostScope } from './scope';

export const OUTCOME_LABELS: Record<Outcome, string> = {
  served: 'Served',
  waf: 'Blocked by WAF',
  geo: 'Geo rules',
  access: 'Access rules',
  auth: 'Sign-in required',
  rate_limit: 'Rate limited',
};

const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx', 'other'] as const;
const DEFAULT_TOP_HOSTS = 4;
const MAX_TOP_HOSTS = 10;

export type AnalyticsQuery = {
  range: ResolvedRange;
  filters: AnalyticsFilter[];
  metric: Metric;
  groupBy: Grouping;
  /** Hosts shown on their own when grouping by host; the rest are "other". */
  topHosts: number;
};

/** Validates a query (throws ApiValidationError). */
export function parseAnalyticsQuery(
  input: { range?: unknown; from?: unknown; to?: unknown; filters?: unknown; metric?: unknown; groupBy?: unknown; topHosts?: unknown },
  now = Math.floor(Date.now() / 1000),
  fallback: RangePreset = '24h'
): AnalyticsQuery {
  const metric = parseMetric(input.metric);
  let topHosts = DEFAULT_TOP_HOSTS;
  if (input.topHosts !== undefined && input.topHosts !== null && input.topHosts !== '') {
    topHosts = Number(input.topHosts);
    if (!Number.isInteger(topHosts) || topHosts < 1 || topHosts > MAX_TOP_HOSTS) {
      throw new ApiValidationError(`topHosts must be between 1 and ${MAX_TOP_HOSTS}`);
    }
  }
  return {
    range: resolveRange(input, now, fallback),
    filters: parseFilters(input.filters),
    metric,
    groupBy: parseGrouping(input.groupBy, metric),
    topHosts,
  };
}

export type Series = { key: string; label: string; values: number[]; total: number };

export type Headline = { value: number; previous: number | null; delta: number | null };

export type AnalyticsQueryResult = {
  status: AnalyticsStatus;
  range: { preset: string; start: number; end: number; step: number; buckets: number };
  metric: Metric;
  groupBy: Grouping;
  filters: AnalyticsFilter[];
  /** Current period, one series per group, `buckets` values each. */
  series: Series[];
  /** Sum of the series per bucket. */
  totals: number[];
  previous:
    | { available: true; start: number; end: number; series: Series[]; totals: number[] }
    | { available: false; reason: 'retention'; start: number; end: number };
  /** The five headline numbers of the current period, with the previous period and the change. */
  headline: {
    requests: Headline;
    bytes: Headline;
    visitors: Headline;
    mitigated: Headline & { share: number };
    /** 5xx responses over requests (a ratio, 0 to 1); `count` is the number of 5xx responses. */
    errorRate5xx: Headline & { count: number };
  };
  /** Per-bucket series of the headline numbers (current period), for sparklines. */
  headlineSeries: { requests: number[]; bytes: number[]; visitors: number[]; mitigated: number[]; errors5xx: number[] };
  /** Bucket with the highest total of the metric, and the one with the most mitigated requests. */
  peak: { index: number; ts: number; value: number } | null;
  peakMitigated: { index: number; ts: number; value: number } | null;
  retention: { days: number; start: number };
};

function seriesLabel(groupBy: Grouping, key: string): string {
  if (groupBy === 'outcome') return OUTCOME_LABELS[key as Outcome] ?? key;
  if (groupBy === 'host') return key === OTHER_HOSTS ? 'Other hosts' : key;
  if (groupBy === 'status') return key === 'other' ? 'Other' : key;
  return 'Total';
}

function orderKeys(groupBy: Grouping, keys: string[], totals: Map<string, number>): string[] {
  if (groupBy === 'outcome') return [...OUTCOMES].filter((key) => keys.includes(key));
  if (groupBy === 'status') return [...STATUS_CLASSES].filter((key) => keys.includes(key));
  if (groupBy === 'host') {
    return keys
      .filter((key) => key !== OTHER_HOSTS)
      .sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0) || a.localeCompare(b))
      .concat(keys.includes(OTHER_HOSTS) ? [OTHER_HOSTS] : []);
  }
  return keys;
}

function peakOf(values: number[], range: ResolvedRange): { index: number; ts: number; value: number } | null {
  let index = -1;
  for (let i = 0; i < values.length; i++) if (values[i] > 0 && (index === -1 || values[i] > values[index])) index = i;
  return index === -1 ? null : { index, ts: range.start + index * range.step, value: values[index] };
}

function sumColumns(series: Series[], buckets: number): number[] {
  const out = new Array<number>(buckets).fill(0);
  for (const s of series) s.values.forEach((v, i) => { out[i] += v; });
  return out;
}

function emptyResult(query: AnalyticsQuery, now: number): Omit<AnalyticsQueryResult, 'status'> {
  const { range } = query;
  const zeros = () => new Array<number>(range.buckets).fill(0);
  const prev = previousPeriod(range, now);
  const headline = (): Headline => ({ value: 0, previous: prev.available ? 0 : null, delta: null });
  return {
    range: { preset: range.preset, start: range.start, end: range.end, step: range.step, buckets: range.buckets },
    metric: query.metric,
    groupBy: query.groupBy,
    filters: query.filters,
    series: [],
    totals: zeros(),
    previous: prev.available ? { ...prev, series: [], totals: zeros() } : prev,
    headline: {
      requests: headline(),
      bytes: headline(),
      visitors: headline(),
      mitigated: { ...headline(), share: 0 },
      errorRate5xx: { ...headline(), count: 0 },
    },
    headlineSeries: { requests: zeros(), bytes: zeros(), visitors: zeros(), mitigated: zeros(), errors5xx: zeros() },
    peak: null,
    peakMitigated: null,
    retention: { days: getRetentionDays(), start: retentionStart(now) },
  };
}

/** Runs `query` for the hosts in `scope`. Never throws for ClickHouse failures (status says so). */
export async function queryAnalytics(
  query: AnalyticsQuery,
  now = Math.floor(Date.now() / 1000),
  scope: HostScope = null
): Promise<AnalyticsQueryResult> {
  const empty = emptyResult(query, now);
  return withAnalytics('query', empty, async () => {
    const { range, metric, groupBy } = query;
    const prev = previousPeriod(range, now);
    const windowStart = prev.available ? prev.start : range.start;
    const offset = prev.available ? range.buckets : 0;
    const scoped = scopeSql(scope);
    const filtered = buildFilterSql(query.filters);
    const base: QueryParams = {
      ...scoped.params,
      ...filtered.params,
      p_start: windowStart,
      p_end: range.end,
      p_cur: range.start,
      p_step: range.step,
    };
    const where = `ts >= toDateTime({p_start:UInt32}) AND ts < toDateTime({p_end:UInt32}) AND ${scoped.sql} AND ${filtered.sql}`;
    const bucket = 'intDiv(toUInt32(ts) - {p_start:UInt32}, {p_step:UInt32})';

    let groupSql = "'total'";
    if (groupBy === 'outcome') groupSql = OUTCOME_SQL;
    else if (groupBy === 'status') groupSql = STATUS_CLASS_SQL;
    else if (groupBy === 'host') {
      const top = await selectRows<{ g: string }>(
        `SELECT host AS g, ${METRIC_SQL[metric]} AS v
         FROM traffic_events
         WHERE ts >= toDateTime({p_cur:UInt32}) AND ts < toDateTime({p_end:UInt32}) AND ${scoped.sql} AND ${filtered.sql}
         GROUP BY g ORDER BY v DESC, g LIMIT {p_top:UInt32}`,
        { ...base, p_top: query.topHosts }
      );
      base.p_top_hosts = top.map((row) => row.g);
      groupSql = top.length > 0 ? `if(host IN {p_top_hosts:Array(String)}, host, '${OTHER_HOSTS}')` : `'${OTHER_HOSTS}'`;
    }

    const [grouped, kpis, uniques] = await Promise.all([
      selectRows<{ b: unknown; g: string; v: unknown }>(
        `SELECT ${bucket} AS b, ${groupSql} AS g, ${METRIC_SQL[metric]} AS v
         FROM traffic_events WHERE ${where}
         GROUP BY b, g`,
        base
      ),
      selectRows<{ b: unknown; requests: unknown; bytes: unknown; visitors: unknown; mitigated: unknown; e5: unknown }>(
        `SELECT ${bucket} AS b, count() AS requests, sum(bytes_sent) AS bytes, uniq(client_ip) AS visitors,
                countIf(${MITIGATED_SQL}) AS mitigated, countIf(status >= 500) AS e5
         FROM traffic_events WHERE ${where}
         GROUP BY b`,
        base
      ),
      selectRows<{ visitors: unknown; p_visitors: unknown }>(
        `SELECT uniqIf(client_ip, ts >= toDateTime({p_cur:UInt32})) AS visitors,
                uniqIf(client_ip, ts < toDateTime({p_cur:UInt32})) AS p_visitors
         FROM traffic_events WHERE ${where}`,
        base
      ),
    ]);

    const n = range.buckets;
    // Series values by key, for the previous (index 0) and current (index 1) period.
    const byKey = new Map<string, [number[], number[]]>();
    for (const row of grouped) {
      const b = num(row.b);
      const key = String(row.g ?? '');
      if (!Number.isInteger(b) || b < 0 || b >= offset + n) continue;
      const slot = byKey.get(key) ?? [new Array<number>(n).fill(0), new Array<number>(n).fill(0)];
      if (b >= offset) slot[1][b - offset] += num(row.v);
      else slot[0][b] += num(row.v);
      byKey.set(key, slot);
    }
    const currentTotals = new Map([...byKey].map(([key, [, cur]]) => [key, cur.reduce((a, v) => a + v, 0)]));
    const keys = orderKeys(
      groupBy,
      [...byKey.keys()].filter((key) => (currentTotals.get(key) ?? 0) > 0 || byKey.get(key)![0].some((v) => v > 0)),
      currentTotals
    );
    const series: Series[] = keys.map((key) => ({
      key,
      label: seriesLabel(groupBy, key),
      values: byKey.get(key)![1],
      total: currentTotals.get(key) ?? 0,
    }));
    const previousSeries: Series[] = keys.map((key) => {
      const values = byKey.get(key)![0];
      return { key, label: seriesLabel(groupBy, key), values, total: values.reduce((a, v) => a + v, 0) };
    });

    // [previous period, current period] per headline number.
    const pair = (): [number[], number[]] => [new Array<number>(n).fill(0), new Array<number>(n).fill(0)];
    const columns = { requests: pair(), bytes: pair(), visitors: pair(), mitigated: pair(), e5: pair() };
    for (const row of kpis) {
      const b = num(row.b);
      if (!Number.isInteger(b) || b < 0 || b >= offset + n) continue;
      const period = b >= offset ? 1 : 0;
      const i = b >= offset ? b - offset : b;
      columns.requests[period][i] += num(row.requests);
      columns.bytes[period][i] += num(row.bytes);
      columns.visitors[period][i] += num(row.visitors);
      columns.mitigated[period][i] += num(row.mitigated);
      columns.e5[period][i] += num(row.e5);
    }
    const total = (values: number[]) => values.reduce((a, v) => a + v, 0);
    const cur = {
      requests: total(columns.requests[1]),
      bytes: total(columns.bytes[1]),
      mitigated: total(columns.mitigated[1]),
      e5: total(columns.e5[1]),
      visitors: num(uniques[0]?.visitors),
    };
    const old = prev.available
      ? {
          requests: total(columns.requests[0]),
          bytes: total(columns.bytes[0]),
          mitigated: total(columns.mitigated[0]),
          e5: total(columns.e5[0]),
          visitors: num(uniques[0]?.p_visitors),
        }
      : null;
    const headline = (key: keyof typeof cur): Headline => ({
      value: cur[key],
      previous: old ? old[key] : null,
      delta: delta(cur[key], old ? old[key] : null),
    });
    const rate = ratio(cur.e5, cur.requests);
    const previousRate = old ? ratio(old.e5, old.requests) : null;

    const totals = sumColumns(series, n);
    return {
      ...empty,
      series,
      totals,
      previous: prev.available ? { ...prev, series: previousSeries, totals: sumColumns(previousSeries, n) } : prev,
      headline: {
        requests: headline('requests'),
        bytes: headline('bytes'),
        visitors: headline('visitors'),
        mitigated: { ...headline('mitigated'), share: ratio(cur.mitigated, cur.requests) },
        errorRate5xx: {
          value: rate,
          previous: previousRate,
          delta: old && old.requests > 0 && old.e5 > 0 ? rate / (previousRate as number) - 1 : null,
          count: cur.e5,
        },
      },
      headlineSeries: {
        requests: columns.requests[1],
        bytes: columns.bytes[1],
        visitors: columns.visitors[1],
        mitigated: columns.mitigated[1],
        errors5xx: columns.e5[1],
      },
      peak: peakOf(totals, range),
      peakMitigated: peakOf(columns.mitigated[1], range),
    };
  });
}

/** Labels of the dimensions, for clients building filter menus. */
export function dimensionLabels(): Record<string, string> {
  return Object.fromEntries(Object.entries(DIMENSION_SPECS).map(([dim, spec]) => [dim, spec.label]));
}
