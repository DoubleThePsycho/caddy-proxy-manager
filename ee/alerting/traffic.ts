// SPDX-License-Identifier: Elastic-2.0
/**
 * ClickHouse reads for alert rules that look at traffic (error_rate, and
 * waf_spike limited to chosen hosts). Every value is a bound parameter.
 * Callers check isAnalyticsEnabled() first and treat a failed query as
 * "cannot tell" (the rule is skipped, nothing resolves).
 */
import { getClient } from "@/src/lib/clickhouse/client";

export type HostTraffic = { host: string; requests: number; errors5xx: number };
export type ErrorBreakdown = { status: number; method: string; path: string; count: number; firstAt: string; lastAt: string };
export type HostWafBlocks = { host: string; blocked: number };

/** Request hosts seen in one window are bounded; this keeps a flood of bogus Host headers cheap. */
const MAX_HOSTS = 5000;

async function rows<T>(query: string, params: Record<string, unknown>): Promise<T[]> {
  const result = await getClient().query({ query, query_params: params, format: "JSONEachRow" });
  return result.json<T>();
}

function window(from: number, to: number): Record<string, number> {
  return { p_from: Math.max(0, Math.floor(from)), p_to: Math.max(0, Math.floor(to)) };
}

/** Requests and 5xx responses per request host in [from, to] (Unix seconds). */
export async function queryHostErrorCounts(from: number, to: number): Promise<HostTraffic[]> {
  const result = await rows<{ host: string; requests: string; errors: string }>(
    `SELECT host, count() AS requests, countIf(status >= 500 AND status < 600) AS errors
     FROM traffic_events
     WHERE ts >= toDateTime({p_from:UInt32}) AND ts <= toDateTime({p_to:UInt32})
     GROUP BY host
     ORDER BY requests DESC
     LIMIT {p_limit:UInt32}`,
    { ...window(from, to), p_limit: MAX_HOSTS }
  );
  return result.map((row) => ({ host: String(row.host).toLowerCase(), requests: Number(row.requests), errors5xx: Number(row.errors) }));
}

/** The most frequent 5xx responses of `hosts` in [from, to]: status, method, path without query string. */
export async function queryErrorBreakdown(from: number, to: number, hosts: string[], limit = 5): Promise<ErrorBreakdown[]> {
  if (hosts.length === 0) return [];
  const result = await rows<{ status: string; method: string; path: string; c: string; first: string; last: string }>(
    `SELECT status, method, splitByChar('?', uri)[1] AS path, count() AS c, toUInt32(min(ts)) AS first, toUInt32(max(ts)) AS last
     FROM traffic_events
     WHERE ts >= toDateTime({p_from:UInt32}) AND ts <= toDateTime({p_to:UInt32})
       AND host IN {p_hosts:Array(String)}
       AND status >= 500 AND status < 600
     GROUP BY status, method, path
     ORDER BY c DESC
     LIMIT {p_limit:UInt32}`,
    { ...window(from, to), p_hosts: hosts.slice(0, 500), p_limit: Math.max(1, Math.min(limit, 20)) }
  );
  return result.map((row) => ({
    status: Number(row.status),
    method: String(row.method).slice(0, 16),
    path: String(row.path).replace(/\p{Cc}+/gu, " ").slice(0, 120),
    count: Number(row.c),
    firstAt: fromUnix(row.first),
    lastAt: fromUnix(row.last),
  }));
}

/** WAF events that were blocked, per request host, in [from, to]. */
export async function queryWafBlockedByHost(from: number, to: number): Promise<HostWafBlocks[]> {
  const result = await rows<{ host: string; blocked: string }>(
    `SELECT host, countIf(blocked) AS blocked
     FROM waf_events
     WHERE ts >= toDateTime({p_from:UInt32}) AND ts <= toDateTime({p_to:UInt32})
     GROUP BY host
     LIMIT {p_limit:UInt32}`,
    { ...window(from, to), p_limit: MAX_HOSTS }
  );
  return result.map((row) => ({ host: String(row.host).toLowerCase(), blocked: Number(row.blocked) }));
}

/** Unix seconds (toUInt32(ts)) as ISO 8601. */
function fromUnix(value: string | number): string {
  const seconds = Number(value);
  return new Date((Number.isFinite(seconds) ? seconds : 0) * 1000).toISOString();
}
