/**
 * SSR-stable date/time formatting.
 *
 * `Date#toLocaleString()` resolves locale and timezone from the runtime
 * environment, so the Node server (container: en-US, UTC) and the browser
 * (user's locale/timezone, e.g. de-DE, Europe/Berlin) render the same
 * timestamp differently — "9/3/2026, 10:23:46 AM" vs "03.09.2026, 12:23:46".
 * That made timestamps flip between slashes and dots depending on whether a
 * page was server-rendered (refresh) or reached via client-side navigation
 * (login) — see issue #233 — and caused hydration text mismatches.
 *
 * These helpers pin both locale and timezone so server and client render
 * byte-identical output. Event/audit timestamps are shown in UTC by
 * formatDateTimeUtc; the preference-aware helpers below take the account's
 * time zone and number format explicitly (src/lib/preferences-shared.ts), so
 * they stay deterministic too. Client components get them already bound to
 * the signed-in account from useFormat() (src/components/preferences).
 */
import { DEFAULT_PREFERENCES, type NumberFormatPreference, type UserPreferences } from "./preferences-shared";

const dateTimeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

type DateInput = Date | number | string;

function toDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value);
}

/** e.g. "03/09/2026, 14:05:09" (UTC, independent of server/browser locale). */
export function formatDateTimeUtc(value: DateInput): string {
  return dateTimeFormat.format(toDate(value));
}

// ── Preference-aware formatting ──────────────────────────────────────────

/** What the preference-aware helpers need: a time zone and a number format. */
export type FormatPreferences = Pick<UserPreferences, "timeZone" | "numberFormat">;

const formatterCache = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat>();

function cached<T extends Intl.DateTimeFormat | Intl.NumberFormat>(key: string, create: () => T): T {
  let formatter = formatterCache.get(key) as T | undefined;
  if (!formatter) {
    formatter = create();
    if (formatterCache.size > 200) formatterCache.clear();
    formatterCache.set(key, formatter);
  }
  return formatter;
}

function dateTimeFormatter(timeZone: string, options: Intl.DateTimeFormatOptions, name: string): Intl.DateTimeFormat {
  return cached(`dt:${name}:${timeZone}`, () => {
    try {
      return new Intl.DateTimeFormat("en-GB", { ...options, timeZone });
    } catch {
      return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" });
    }
  });
}

const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
};

/** e.g. "3 Oct 2026, 11:36 CEST", in the given time zone (UTC by default). */
export function formatDateTime(value: DateInput, prefs: Partial<FormatPreferences> = DEFAULT_PREFERENCES): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return "";
  return dateTimeFormatter(prefs.timeZone ?? DEFAULT_PREFERENCES.timeZone, DATE_TIME_OPTIONS, "datetime").format(date);
}

/** e.g. "3 Oct 2026", in the given time zone. */
export function formatDate(value: DateInput, prefs: Partial<FormatPreferences> = DEFAULT_PREFERENCES): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return "";
  return dateTimeFormatter(prefs.timeZone ?? DEFAULT_PREFERENCES.timeZone, { day: "numeric", month: "short", year: "numeric" }, "date").format(date);
}

/** e.g. "11:36", in the given time zone. */
export function formatTime(value: DateInput, prefs: Partial<FormatPreferences> = DEFAULT_PREFERENCES): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return "";
  return dateTimeFormatter(prefs.timeZone ?? DEFAULT_PREFERENCES.timeZone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, "time").format(date);
}

/** A number with the account's digit grouping and decimal mark, e.g. 61,817 / 61.817 / 61 817. */
export function formatNumber(
  value: number,
  prefs: Partial<FormatPreferences> = DEFAULT_PREFERENCES,
  options: Intl.NumberFormatOptions = {}
): string {
  if (!Number.isFinite(value)) return "";
  const locale: NumberFormatPreference = prefs.numberFormat ?? DEFAULT_PREFERENCES.numberFormat;
  return cached(`n:${locale}:${JSON.stringify(options)}`, () => new Intl.NumberFormat(locale, options)).format(value);
}

/** A share (0.018 is 1.8%), with the account's number format. */
export function formatPercent(value: number, prefs: Partial<FormatPreferences> = DEFAULT_PREFERENCES, fractionDigits = 1): string {
  return formatNumber(value, prefs, { style: "percent", maximumFractionDigits: fractionDigits });
}

/** "Now", "5 minutes ago", "3 hours ago", "2 days ago"; past times only, relative to `now`. */
export function formatRelative(value: DateInput, now: DateInput = Date.now()): string {
  const minutes = Math.round((toDate(now).getTime() - toDate(value).getTime()) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "Now";
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}
