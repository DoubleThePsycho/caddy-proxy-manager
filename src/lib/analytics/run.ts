/**
 * Runs analytics queries against ClickHouse and turns "analytics off" and
 * "ClickHouse unreachable or failing" into an empty result with an explicit
 * status, so a page or API caller shows "no data" instead of an error.
 */
import { getClient, isAnalyticsEnabled } from '../clickhouse/client';

/**
 * ok: the data came from ClickHouse. disabled: analytics is not configured
 * (CLICKHOUSE_PASSWORD unset). unavailable: ClickHouse could not answer; the
 * data is empty.
 */
export type AnalyticsStatus = 'ok' | 'disabled' | 'unavailable';

/** Longest a single analytics query may run, in seconds. */
const MAX_EXECUTION_SECONDS = 30;

export type QueryParams = Record<string, unknown>;

/** Rows of one SELECT. Throws when ClickHouse fails; use withAnalytics around it. */
export async function selectRows<T>(query: string, params: QueryParams = {}): Promise<T[]> {
  const result = await getClient().query({
    query,
    query_params: params,
    format: 'JSONEachRow',
    clickhouse_settings: { max_execution_time: MAX_EXECUTION_SECONDS },
  });
  return result.json<T>();
}

export async function selectRow<T>(query: string, params: QueryParams = {}): Promise<T | null> {
  return (await selectRows<T>(query, params))[0] ?? null;
}

/**
 * `run()` with the status: `empty` (marked "disabled") when analytics is off,
 * `empty` (marked "unavailable") when any query fails. The failure is logged
 * without its message, which can echo query text.
 */
export async function withAnalytics<T extends object>(
  operation: string,
  empty: T,
  run: () => Promise<T>
): Promise<T & { status: AnalyticsStatus }> {
  if (!isAnalyticsEnabled()) return { ...empty, status: 'disabled' };
  try {
    return { ...(await run()), status: 'ok' };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code).slice(0, 40) : '';
    const type = error instanceof Error ? error.name : typeof error;
    console.warn(`[analytics] ${operation} failed (${type}${code ? ` ${code}` : ''}); returning no data`);
    return { ...empty, status: 'unavailable' };
  }
}

/** Number from a ClickHouse JSON value (UInt64 and friends arrive as strings). */
export function num(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
  return Number.isFinite(n) ? n : 0;
}

/** `part / whole`, or 0 when whole is 0. */
export function ratio(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

/** Relative change from `previous` to `current`; null when there is nothing to compare to. */
export function delta(current: number, previous: number | null): number | null {
  if (previous === null || previous === 0) return null;
  return current / previous - 1;
}
