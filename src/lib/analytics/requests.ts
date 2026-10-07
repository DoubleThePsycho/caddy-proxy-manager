/**
 * The latest requests matching a query: the request log under the analytics
 * charts. Paths are returned without their query string, which can carry
 * credentials.
 */
import { ApiValidationError } from '../api-errors';
import { COUNTRY_SQL, OUTCOME_SQL, PATH_SQL, UA_SQL } from './dimensions';
import { buildFilterSql, type AnalyticsFilter } from './filters';
import type { Outcome } from './outcome';
import type { ResolvedRange } from './range';
import { num, selectRows, withAnalytics, type AnalyticsStatus } from './run';

export const DEFAULT_REQUEST_LIMIT = 50;
export const MAX_REQUEST_LIMIT = 500;
export const MAX_REQUEST_OFFSET = 10_000;

export type RequestLogEntry = {
  ts: number;
  outcome: Outcome;
  method: string;
  host: string;
  path: string;
  status: number;
  country: string;
  asn: number;
  asOrg: string;
  ip: string;
  userAgent: string;
  durationMs: number;
  bytes: number;
  /** The WAF rule that blocked it (0: none). */
  wafRuleId: number;
};

export type RequestLogResult = { status: AnalyticsStatus; requests: RequestLogEntry[]; limit: number; offset: number };

export function parsePaging(input: { limit?: unknown; offset?: unknown }, defaultLimit = DEFAULT_REQUEST_LIMIT, maxLimit = MAX_REQUEST_LIMIT) {
  const limit = input.limit === undefined || input.limit === null || input.limit === '' ? defaultLimit : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) throw new ApiValidationError(`limit must be between 1 and ${maxLimit}`);
  const offset = input.offset === undefined || input.offset === null || input.offset === '' ? 0 : Number(input.offset);
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_REQUEST_OFFSET) {
    throw new ApiValidationError(`offset must be between 0 and ${MAX_REQUEST_OFFSET}`);
  }
  return { limit, offset };
}

/** Newest first. */
export async function queryRequestLog(input: {
  range: ResolvedRange;
  filters: AnalyticsFilter[];
  limit: number;
  offset: number;
}): Promise<RequestLogResult> {
  const empty = { requests: [] as RequestLogEntry[], limit: input.limit, offset: input.offset };
  return withAnalytics('request log', empty, async () => {
    const filtered = buildFilterSql(input.filters);
    const rows = await selectRows<Record<string, unknown>>(
      `SELECT toUInt32(ts) AS t, ${OUTCOME_SQL} AS o, method, host, ${PATH_SQL} AS path, status,
              ${COUNTRY_SQL} AS country, asn, as_org, client_ip, ${UA_SQL} AS ua, duration_ms, bytes_sent, waf_rule_id
       FROM traffic_events
       WHERE ts >= toDateTime({p_from:UInt32}) AND ts < toDateTime({p_to:UInt32}) AND ${filtered.sql}
       ORDER BY ts DESC
       LIMIT {p_limit:UInt32} OFFSET {p_offset:UInt32}`,
      {
        ...filtered.params,
        p_from: input.range.start,
        p_to: input.range.end,
        p_limit: input.limit,
        p_offset: input.offset,
      }
    );
    return {
      ...empty,
      requests: rows.map((row) => ({
        ts: num(row.t),
        outcome: String(row.o) as Outcome,
        method: String(row.method ?? ''),
        host: String(row.host ?? ''),
        path: String(row.path ?? ''),
        status: num(row.status),
        country: String(row.country ?? ''),
        asn: num(row.asn),
        asOrg: String(row.as_org ?? ''),
        ip: String(row.client_ip ?? ''),
        userAgent: String(row.ua ?? ''),
        durationMs: num(row.duration_ms),
        bytes: num(row.bytes_sent),
        wafRuleId: num(row.waf_rule_id),
      })),
    };
  });
}
