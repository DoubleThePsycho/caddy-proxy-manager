/**
 * Traffic per proxy host: the numbers and sparklines of the hosts list (one
 * batched query for any number of hosts) and the summary of one host's
 * detail page. A proxy host's traffic is that of the stored host names its
 * domains serve (scope.ts).
 */
import { HOST_NAME_SQL, MITIGATED_SQL, PATH_SQL } from './dimensions';
import { sparklineStep, type ResolvedRange } from './range';
import { num, ratio, selectRows, withAnalytics, type AnalyticsStatus } from './run';
import {
  domainMatcher,
  domainSql,
  exactDomainsTakenByOthers,
  proxyHostForName,
  scopeSql,
  type HostScope,
  type ProxyHostDomains,
} from './scope';

export type HostSummary = {
  proxyHostId: number;
  requests: number;
  errors5xx: number;
  /** 5xx responses over requests, 0 to 1. */
  errorRate5xx: number;
  mitigated: number;
  bytes: number;
  /** Requests per sparkline bucket over the range. */
  sparkline: number[];
};

export type HostSummariesResult = {
  status: AnalyticsStatus;
  range: { preset: string; start: number; end: number };
  /** Seconds per sparkline point. */
  sparklineStep: number;
  hosts: HostSummary[];
};

/**
 * Summaries of `hosts` (the ones the caller may see). `allHosts` is every
 * proxy host, so a name that is another host's exact domain is not counted
 * for a wildcard host.
 */
export async function queryHostSummaries(
  input: { range: ResolvedRange; hosts: readonly ProxyHostDomains[]; allHosts: readonly ProxyHostDomains[] },
  scope: HostScope
): Promise<HostSummariesResult> {
  const { range } = input;
  const step = sparklineStep(range);
  const points = Math.ceil((range.end - range.start) / step);
  const blank = (id: number): HostSummary => ({
    proxyHostId: id,
    requests: 0,
    errors5xx: 0,
    errorRate5xx: 0,
    mitigated: 0,
    bytes: 0,
    sparkline: new Array<number>(points).fill(0),
  });
  const empty = {
    range: { preset: range.preset, start: range.start, end: range.end },
    sparklineStep: step,
    hosts: input.hosts.map((host) => blank(host.id)),
  };
  return withAnalytics('host summaries', empty, async () => {
    if (input.hosts.length === 0) return empty;
    const matcher = domainMatcher(input.hosts.flatMap((host) => host.domains));
    const domains = domainSql(matcher);
    const scoped = scopeSql(scope);
    const rows = await selectRows<Record<string, unknown>>(
      `SELECT ${HOST_NAME_SQL} AS name, intDiv(toUInt32(ts) - {p_from:UInt32}, {p_step:UInt32}) AS b,
              count() AS requests, countIf(status >= 500) AS e5, countIf(${MITIGATED_SQL}) AS m, sum(bytes_sent) AS bytes
       FROM traffic_events
       WHERE ts >= toDateTime({p_from:UInt32}) AND ts < toDateTime({p_to:UInt32}) AND ${scoped.sql} AND ${domains.sql}
       GROUP BY name, b`,
      { ...scoped.params, ...domains.params, p_from: range.start, p_to: range.end, p_step: step }
    );
    const wanted = new Map(input.hosts.map((host) => [host.id, blank(host.id)]));
    const owner = new Map<string, number | null>();
    for (const row of rows) {
      const name = String(row.name ?? '');
      if (!owner.has(name)) owner.set(name, proxyHostForName(name, input.allHosts));
      const summary = wanted.get(owner.get(name) ?? -1);
      if (!summary) continue;
      const requests = num(row.requests);
      summary.requests += requests;
      summary.errors5xx += num(row.e5);
      summary.mitigated += num(row.m);
      summary.bytes += num(row.bytes);
      const b = num(row.b);
      if (Number.isInteger(b) && b >= 0 && b < points) summary.sparkline[b] += requests;
    }
    for (const summary of wanted.values()) summary.errorRate5xx = ratio(summary.errors5xx, summary.requests);
    return { ...empty, hosts: [...wanted.values()] };
  });
}

export type HostDetailResult = {
  status: AnalyticsStatus;
  proxyHostId: number;
  range: { preset: string; start: number; end: number; step: number; buckets: number };
  totals: {
    requests: number;
    errors5xx: number;
    errorRate5xx: number;
    mitigated: number;
    bytes: number;
    /** Distinct client addresses. */
    clients: number;
  };
  series: { requests: number[]; errors5xx: number[]; mitigated: number[]; bytes: number[] };
  /** Busiest paths, with their most frequent status codes. */
  topPaths: { path: string; count: number; mitigated: number; statuses: { status: number; count: number }[] }[];
  statusCodes: { status: number; count: number; share: number }[];
};

const TOP_PATHS = 10;
const STATUSES_PER_PATH = 3;

/** Summary of one proxy host (the caller must already be allowed to see it). */
export async function queryHostDetail(
  input: { range: ResolvedRange; host: ProxyHostDomains; allHosts: readonly ProxyHostDomains[] },
  scope: HostScope
): Promise<HostDetailResult> {
  const { range, host } = input;
  const zeros = () => new Array<number>(range.buckets).fill(0);
  const empty = {
    proxyHostId: host.id,
    range: { preset: range.preset, start: range.start, end: range.end, step: range.step, buckets: range.buckets },
    totals: { requests: 0, errors5xx: 0, errorRate5xx: 0, mitigated: 0, bytes: 0, clients: 0 },
    series: { requests: zeros(), errors5xx: zeros(), mitigated: zeros(), bytes: zeros() },
    topPaths: [],
    statusCodes: [],
  };
  return withAnalytics('host detail', empty, async () => {
    const domains = domainSql(domainMatcher(host.domains), exactDomainsTakenByOthers(host, input.allHosts));
    const scoped = scopeSql(scope);
    const params = { ...scoped.params, ...domains.params, p_from: range.start, p_to: range.end, p_step: range.step, p_top: TOP_PATHS };
    const where = `ts >= toDateTime({p_from:UInt32}) AND ts < toDateTime({p_to:UInt32}) AND ${scoped.sql} AND ${domains.sql}`;
    const [buckets, totals, paths, statuses] = await Promise.all([
      selectRows<Record<string, unknown>>(
        `SELECT intDiv(toUInt32(ts) - {p_from:UInt32}, {p_step:UInt32}) AS b, count() AS requests, countIf(status >= 500) AS e5,
                countIf(${MITIGATED_SQL}) AS m, sum(bytes_sent) AS bytes
         FROM traffic_events WHERE ${where} GROUP BY b`,
        params
      ),
      selectRows<Record<string, unknown>>(
        `SELECT count() AS requests, countIf(status >= 500) AS e5, countIf(${MITIGATED_SQL}) AS m, sum(bytes_sent) AS bytes,
                uniq(client_ip) AS clients
         FROM traffic_events WHERE ${where}`,
        params
      ),
      selectRows<Record<string, unknown>>(
        `SELECT ${PATH_SQL} AS path, count() AS c, countIf(${MITIGATED_SQL}) AS m, sumMap([status], [toUInt64(1)]) AS by_status
         FROM traffic_events WHERE ${where}
         GROUP BY path ORDER BY c DESC, path LIMIT {p_top:UInt32}`,
        params
      ),
      selectRows<Record<string, unknown>>(
        `SELECT status, count() AS c FROM traffic_events WHERE ${where} GROUP BY status ORDER BY c DESC, status`,
        params
      ),
    ]);
    const series = { requests: zeros(), errors5xx: zeros(), mitigated: zeros(), bytes: zeros() };
    for (const row of buckets) {
      const b = num(row.b);
      if (!Number.isInteger(b) || b < 0 || b >= range.buckets) continue;
      series.requests[b] = num(row.requests);
      series.errors5xx[b] = num(row.e5);
      series.mitigated[b] = num(row.m);
      series.bytes[b] = num(row.bytes);
    }
    const total = totals[0] ?? {};
    const requests = num(total.requests);
    return {
      ...empty,
      totals: {
        requests,
        errors5xx: num(total.e5),
        errorRate5xx: ratio(num(total.e5), requests),
        mitigated: num(total.m),
        bytes: num(total.bytes),
        clients: num(total.clients),
      },
      series,
      topPaths: paths.map((row) => ({
        path: String(row.path ?? ''),
        count: num(row.c),
        mitigated: num(row.m),
        statuses: statusBreakdown(row.by_status),
      })),
      statusCodes: statuses.map((row) => ({ status: num(row.status), count: num(row.c), share: ratio(num(row.c), requests) })),
    };
  });
}

/** sumMap's ([statuses], [counts]) as the most frequent statuses first. */
function statusBreakdown(value: unknown): { status: number; count: number }[] {
  const pair = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
  const [statuses, counts] = pair as [unknown, unknown];
  if (!Array.isArray(statuses) || !Array.isArray(counts)) return [];
  return statuses
    .map((status, i) => ({ status: num(status), count: num(counts[i]) }))
    .sort((a, b) => b.count - a.count || a.status - b.status)
    .slice(0, STATUSES_PER_PATH);
}
