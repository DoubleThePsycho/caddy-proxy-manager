/**
 * Dates and small text helpers of the overview, in the viewer's time zone
 * (their preferences, useFormat().timeZone). Pure functions: the page passes
 * the server's "now", so server and browser render the same text.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function zoned(timeZone: string, options: Intl.DateTimeFormatOptions, name: string): Intl.DateTimeFormat {
  const key = `${name}:${timeZone}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat("en-GB", { ...options, timeZone });
    } catch {
      formatter = new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" });
    }
    if (formatters.size > 100) formatters.clear();
    formatters.set(key, formatter);
  }
  return formatter;
}

const CLOCK: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };

/** "11:36". */
export function clockLabel(ms: number, timeZone: string): string {
  return zoned(timeZone, CLOCK, "clock").format(ms);
}

/** "UTC", "CEST", "GMT-4": the zone's short name at that moment. */
export function zoneLabel(ms: number, timeZone: string): string {
  const parts = zoned(timeZone, { ...CLOCK, timeZoneName: "short" }, "zone").formatToParts(ms);
  return parts.find((part) => part.type === "timeZoneName")?.value ?? timeZone;
}

/** "Saturday 3 October · 11:36 UTC", the line above the overview's title. */
export function headerDateLine(ms: number, timeZone: string): string {
  const day = zoned(timeZone, { weekday: "long", day: "numeric", month: "long" }, "header").format(ms).replace(",", "");
  return `${day} · ${clockLabel(ms, timeZone)} ${zoneLabel(ms, timeZone)}`;
}

function dayKey(ms: number, timeZone: string): string {
  return zoned(timeZone, { year: "numeric", month: "2-digit", day: "2-digit" }, "day").format(ms);
}

/** "3 Oct". */
function dayMonth(ms: number, timeZone: string): string {
  return zoned(timeZone, { day: "numeric", month: "short" }, "daymonth").format(ms);
}

/**
 * A chart bucket: "14:30" for buckets under three hours, "Sat 06:00" for
 * longer ones, "3 Oct" for days; with `long`, the day and the zone too.
 */
export function bucketLabel(ms: number, stepSeconds: number, long: boolean, timeZone: string): string {
  if (stepSeconds >= 86_400) return dayMonth(ms, timeZone);
  const weekday = zoned(timeZone, { weekday: "short" }, "weekday").format(ms);
  if (long) return `${weekday} ${dayMonth(ms, timeZone)}, ${clockLabel(ms, timeZone)} ${zoneLabel(ms, timeZone)}`;
  return stepSeconds >= 10_800 ? `${weekday} ${clockLabel(ms, timeZone)}` : clockLabel(ms, timeZone);
}

/** A moment inside a chart of `stepSeconds` buckets: "21:30", or "Sat 06:00" over several days. */
export function momentLabel(ms: number, stepSeconds: number, timeZone: string): string {
  return stepSeconds >= 10_800 ? bucketLabel(ms, stepSeconds, false, timeZone) : clockLabel(ms, timeZone);
}

/** When a change happened: "10:58" today, "Yesterday 18:22", "2 Oct 18:22", or "2 Oct 2025" in another year. */
export function changeTimeLabel(value: string | number, nowMs: number, timeZone: string): string {
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  const clock = clockLabel(ms, timeZone);
  if (dayKey(ms, timeZone) === dayKey(nowMs, timeZone)) return clock;
  if (dayKey(ms, timeZone) === dayKey(nowMs - 86_400_000, timeZone)) return `Yesterday ${clock}`;
  const year = (t: number) => zoned(timeZone, { year: "numeric" }, "year").format(t);
  return year(ms) === year(nowMs) ? `${dayMonth(ms, timeZone)} ${clock}` : `${dayMonth(ms, timeZone)} ${year(ms)}`;
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function relativeLabel(value: string | number, nowMs: number): string {
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  const minutes = Math.round((nowMs - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** An audit summary after a name: "Created proxy host wiki" reads "created proxy host wiki"; "DNS ..." stays. */
export function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/** "LB" for l.bianchi, "AD" for admin. */
export function initials(name: string): string {
  const parts = name.trim().split(/[\s._@-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : name.trim().slice(0, 2);
  return letters.toUpperCase() || "?";
}

/** The period the KPI changes compare with: "vs previous 24 hours". */
export const PREVIOUS_PERIOD: Record<string, string> = {
  "1h": "previous hour",
  "24h": "previous 24 hours",
  "7d": "previous 7 days",
};
