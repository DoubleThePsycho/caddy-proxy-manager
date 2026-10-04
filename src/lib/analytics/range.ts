/**
 * Time ranges of the analytics queries: a preset (1h, 24h, 7d, 30d) ending
 * now, or a custom from/to. Each range is cut into buckets of a fixed step
 * aligned to the step (UTC), the last one holding "now"; the previous period
 * is the same number of buckets right before it.
 */
import { ApiValidationError } from '../api-errors';
import { getRetentionDays } from '../clickhouse/client';

export const RANGE_PRESETS = {
  '1h': { seconds: 3600, step: 60 },
  '24h': { seconds: 86_400, step: 1800 },
  '7d': { seconds: 7 * 86_400, step: 10_800 },
  '30d': { seconds: 30 * 86_400, step: 86_400 },
} as const;
export type RangePreset = keyof typeof RANGE_PRESETS;

/** Steps a custom range can use, smallest first. */
const STEP_LADDER = [60, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200, 86_400] as const;
/** A custom range gets the smallest step that keeps it at or under this many buckets. */
const TARGET_BUCKETS = 60;
/** Longest custom range. */
export const MAX_RANGE_SECONDS = 92 * 86_400;

export type ResolvedRange = {
  /** The preset, or "custom". */
  preset: RangePreset | 'custom';
  /** First second of the first bucket (inclusive). */
  start: number;
  /** End of the last bucket (exclusive). */
  end: number;
  step: number;
  buckets: number;
};

export type PreviousPeriod =
  | { available: true; start: number; end: number }
  | { available: false; reason: 'retention'; start: number; end: number };

export function isRangePreset(value: unknown): value is RangePreset {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RANGE_PRESETS, value);
}

function parseUnixSeconds(value: unknown, name: string): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,12}$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new ApiValidationError(`${name} must be a Unix time in seconds`);
  return n;
}

/** Smallest ladder step at or above `minimum`. */
export function stepAtLeast(minimum: number): number {
  return STEP_LADDER.find((step) => step >= minimum) ?? STEP_LADDER[STEP_LADDER.length - 1];
}

/**
 * Resolves `range` (a preset; default `fallback`) or `from`/`to` (Unix
 * seconds; both or neither, and then `range` must be absent or "custom").
 */
export function resolveRange(
  input: { range?: unknown; from?: unknown; to?: unknown },
  now = Math.floor(Date.now() / 1000),
  fallback: RangePreset = '24h'
): ResolvedRange {
  const hasFrom = input.from !== undefined && input.from !== null && input.from !== '';
  const hasTo = input.to !== undefined && input.to !== null && input.to !== '';
  const range = input.range === undefined || input.range === null || input.range === '' ? undefined : input.range;
  if (hasFrom || hasTo || range === 'custom') {
    if (!hasFrom || !hasTo) throw new ApiValidationError('A custom range needs both from and to');
    if (range !== undefined && range !== 'custom') throw new ApiValidationError('Give either a range or from and to');
    const from = parseUnixSeconds(input.from, 'from');
    const to = parseUnixSeconds(input.to, 'to');
    if (to <= from) throw new ApiValidationError('to must be after from');
    if (to - from > MAX_RANGE_SECONDS) throw new ApiValidationError('A custom range can cover at most 92 days');
    if (from > now) throw new ApiValidationError('from must not be in the future');
    const step = stepAtLeast(Math.ceil((to - from) / TARGET_BUCKETS));
    const start = Math.floor(from / step) * step;
    const end = Math.ceil(to / step) * step;
    return { preset: 'custom', start, end: Math.max(end, start + step), step, buckets: Math.max(1, (end - start) / step) };
  }
  const preset = range === undefined ? fallback : range;
  if (!isRangePreset(preset)) throw new ApiValidationError(`range must be one of ${Object.keys(RANGE_PRESETS).join(', ')} or custom`);
  const { seconds, step } = RANGE_PRESETS[preset];
  const buckets = seconds / step;
  // The bucket holding "now" is the last one.
  const end = (Math.floor(now / step) + 1) * step;
  return { preset, start: end - buckets * step, end, step, buckets };
}

/** Unix second before which analytics may have been deleted by the TTL. */
export function retentionStart(now = Math.floor(Date.now() / 1000)): number {
  return now - getRetentionDays() * 86_400;
}

/**
 * The period right before `range`, with the same buckets. Unavailable when
 * any of it falls before the retention window: ClickHouse has deleted that
 * data, and a partial period would make every comparison look like growth.
 */
export function previousPeriod(range: ResolvedRange, now = Math.floor(Date.now() / 1000)): PreviousPeriod {
  const length = range.end - range.start;
  const start = range.start - length;
  const end = range.start;
  if (start < retentionStart(now)) return { available: false, reason: 'retention', start, end };
  return { available: true, start, end };
}

/** A smaller step for compact sparklines: about `points` points over the range. */
export function sparklineStep(range: ResolvedRange, points = 24): number {
  return stepAtLeast(Math.ceil((range.end - range.start) / points));
}
