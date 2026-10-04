// SPDX-License-Identifier: Elastic-2.0
/**
 * Read-only ClickHouse access for the AI analyst: aggregate queries with
 * bound parameters and a server-side time limit. Nothing here returns raw log
 * lines to callers outside ee/ai.
 */
import { getClient, isAnalyticsEnabled } from "@/src/lib/clickhouse/client";

export type QueryParams = Record<string, unknown>;
export type AnalyticsQuery = <T>(query: string, params?: QueryParams) => Promise<T[]>;

/** Seconds ClickHouse may spend on one AI-analyst query. */
export const QUERY_TIME_LIMIT_SECONDS = 30;

/** Request host without port, lower-cased (the WAF and access logs keep the Host header as sent). */
export const HOST_EXPR = "replaceRegexpOne(lower(host), ':[0-9]+$', '')";
/** Request path without query string, bounded. */
export const PATH_EXPR = "substring(splitByChar('?', uri)[1], 1, 200)";

export function timeFilter(from = "p_from", to = "p_to"): string {
  return `ts >= toDateTime({${from}:UInt32}) AND ts <= toDateTime({${to}:UInt32})`;
}

export const defaultAnalyticsQuery: AnalyticsQuery = async <T>(query: string, params: QueryParams = {}): Promise<T[]> => {
  const result = await getClient().query({
    query,
    query_params: params,
    format: "JSONEachRow",
    clickhouse_settings: { max_execution_time: QUERY_TIME_LIMIT_SECONDS },
  });
  return result.json<T>();
};

export function analyticsAvailable(): boolean {
  return isAnalyticsEnabled();
}

/** ClickHouse returns 64-bit integers as strings in JSON. */
export function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A printable, single-line, bounded string from a query result. */
export function str(value: unknown, max = 200): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/\p{Cc}+/gu, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}
