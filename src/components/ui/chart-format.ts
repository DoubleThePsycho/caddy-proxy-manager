/**
 * Number, byte, percentage, change and time formatting shared by the charts
 * and KPI tiles (StackedBarChart, StackedAreaChart, Sparkline, KpiTile,
 * TopList, ExpiryTimeline). Pure functions, safe on the server and the client.
 */

/** 61,817 · 18.4k · 214k · 1.24M · 12.3M · 2.10B, as the analytics design shows counts. */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "–";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 1 : 2)}M`;
  if (abs >= 1e4) return `${(value / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}k`;
  return Math.round(value).toLocaleString("en-US");
}

/** Exact count with thousands separators (61,817). */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "–";
  return Math.round(value).toLocaleString("en-US");
}

const BYTE_UNITS = ["B", "kB", "MB", "GB", "TB", "PB"] as const;

/** Decimal byte sizes: 512 B · 1.2 kB · 340 MB · 1.4 GB. */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value)) return "–";
  let v = Math.abs(value);
  let unit = 0;
  while (v >= 1000 && unit < BYTE_UNITS.length - 1) {
    v /= 1000;
    unit++;
  }
  const sign = value < 0 ? "-" : "";
  if (unit === 0) return `${sign}${Math.round(v)} B`;
  return `${sign}${v.toFixed(v >= 100 ? 0 : 1)} ${BYTE_UNITS[unit]}`;
}

/** A fraction as a percentage: one decimal, two under 1% (0.23%), "0%" for zero. */
export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return "–";
  if (fraction === 0) return "0%";
  const abs = Math.abs(fraction);
  return `${(fraction * 100).toFixed(abs < 0.01 ? 2 : 1)}%`;
}

/** How a change reads: good (ok), bad, or neither. */
export type DeltaTone = "ok" | "bad" | "neutral";

/** Which direction of change is good: "up", "down", or null when neither is. */
export type GoodDirection = "up" | "down" | null;

export type Change = {
  /** "▲ 12%", "▼ 33%", "up from 0", "no change" or "No earlier data". */
  text: string;
  tone: DeltaTone;
  /** current / previous − 1, or null when there is no previous value or it is 0. */
  ratio: number | null;
};

/** Changes smaller than this read as neutral whatever the direction. */
export const NEUTRAL_CHANGE = 0.02;

/**
 * The change from `previous` to `current`, with its tone given which way is
 * good. A missing previous value reads "No earlier data"; a previous value of
 * 0 reads "up from 0" (or "no change" when both are 0).
 */
export function formatChange(current: number, previous: number | null | undefined, good: GoodDirection = null): Change {
  if (previous === null || previous === undefined || !Number.isFinite(previous)) {
    return { text: "No earlier data", tone: "neutral", ratio: null };
  }
  if (previous === 0) {
    return { text: current > 0 ? "up from 0" : "no change", tone: "neutral", ratio: null };
  }
  const ratio = current / previous - 1;
  const up = ratio >= 0;
  const tone: DeltaTone =
    Math.abs(ratio) < NEUTRAL_CHANGE || good === null ? "neutral" : (up ? good === "up" : good === "down") ? "ok" : "bad";
  return { text: `${up ? "▲" : "▼"} ${Math.abs(ratio * 100).toFixed(0)}%`, tone, ratio };
}

/** The short signed change used in chart tooltips: "+12%", "−8%", or "" without a previous value. */
export function formatSignedChange(current: number, previous: number | null | undefined): string {
  if (!previous || !Number.isFinite(previous)) return "";
  const ratio = current / previous - 1;
  return `${ratio >= 0 ? "+" : "−"}${Math.abs(ratio * 100).toFixed(0)}%`;
}

/** The smallest "nice" number (1, 2, 2.5, 5 or 10 times a power of ten) at or above `value`. */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.pow(10, Math.floor(Math.log10(value)));
  const fraction = value / exponent;
  const step = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return step * exponent;
}

/** `intervals + 1` evenly spaced ticks from 0 to `max`. */
export function niceTicks(max: number, intervals = 4): number[] {
  const n = Math.max(1, Math.round(intervals));
  return Array.from({ length: n + 1 }, (_, i) => (max * i) / n);
}

/** A y-axis for `values`: a nice maximum with 6% headroom, and its ticks. */
export function chartScale(values: readonly number[], intervals = 4): { max: number; ticks: number[] } {
  let peak = 0;
  for (const v of values) if (Number.isFinite(v) && v > peak) peak = v;
  const max = niceMax(Math.max(1, peak) * 1.06);
  return { max, ticks: niceTicks(max, intervals) };
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const pad2 = (n: number) => String(n).padStart(2, "0");

/** "3 Oct" in UTC. */
export function formatDayUtc(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/**
 * A bucket's start time in UTC for an axis or tooltip, by bucket width:
 * days ("3 Oct"), multi-hour buckets ("Sat 06:00"), otherwise "14:30"
 * ("3 Oct, 14:30" when `long`).
 */
export function formatBucketTime(ms: number, stepSeconds: number, long = false): string {
  const d = new Date(ms);
  if (stepSeconds >= 86400) return formatDayUtc(ms);
  if (stepSeconds >= 10800) {
    const time = `${pad2(d.getUTCHours())}:00`;
    return long ? `${DAYS[d.getUTCDay()]} ${formatDayUtc(ms)}, ${time}` : `${DAYS[d.getUTCDay()]} ${time}`;
  }
  const time = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  return long ? `${formatDayUtc(ms)}, ${time}` : time;
}

/** The bucket width in seconds, from the first two bucket starts (60 when there is only one). */
export function inferStepSeconds(buckets: readonly number[]): number {
  if (buckets.length < 2) return 60;
  const step = Math.round((buckets[1] - buckets[0]) / 1000);
  return step > 0 ? step : 60;
}
