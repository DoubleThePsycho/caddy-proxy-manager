// SPDX-License-Identifier: Elastic-2.0
/**
 * When the daily digest is due, in the administrator's time zone. Pure
 * functions on top of Intl (no dependencies).
 */

const MINUTE_MS = 60_000;
/** A digest whose time passed longer ago than this (the node was down) waits for the next day. */
export const DIGEST_CATCH_UP_MS = 6 * 60 * MINUTE_MS;

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimeOfDay(value: string): boolean {
  return TIME_OF_DAY.test(value);
}

export function isValidTimeZone(value: string): boolean {
  if (!value || value.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

function zonedParts(date: Date, timeZone: string): Parts {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** The calendar date in `timeZone` at `date`, "YYYY-MM-DD". */
export function localDate(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** "YYYY-MM-DD HH:MM" in `timeZone`. */
export function localDateTime(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds. */
function offsetMs(instant: number, timeZone: string): number {
  const p = zonedParts(new Date(instant), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `timeZone` shows `day` ("YYYY-MM-DD")
 * at `time` ("HH:MM"). A time skipped by a daylight-saving change resolves to
 * the instant just after the gap.
 */
export function zonedTimeToUtc(day: string, time: string, timeZone: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const guess = Date.UTC(year, month - 1, date, hour, minute);
  const first = guess - offsetMs(guess, timeZone);
  const second = guess - offsetMs(first, timeZone);
  return new Date(second === first ? first : Math.max(first, second));
}

export function addDays(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

export type DigestScheduleInput = {
  timeOfDay: string;
  timeZone: string;
  /** Local date of the last scheduled send. */
  lastRunDate: string | null;
  /** When the current schedule took effect (enabled, or time changed), ISO 8601. */
  activeSince: string | null;
};

/**
 * Whether the digest is due now, for which local date, and when it runs next.
 * Due once per local day, at or after the configured time, unless that time
 * is more than DIGEST_CATCH_UP_MS ago or came before the schedule was set.
 */
export function digestSchedule(input: DigestScheduleInput, now: Date): { due: boolean; localDate: string; nextRunAt: Date } {
  const today = localDate(now, input.timeZone);
  const todayAt = zonedTimeToUtc(today, input.timeOfDay, input.timeZone);
  const activeSince = input.activeSince ? Date.parse(input.activeSince) : Number.NEGATIVE_INFINITY;
  const pendingToday = input.lastRunDate !== today && todayAt.getTime() >= activeSince;
  const elapsed = now.getTime() - todayAt.getTime();
  const due = pendingToday && elapsed >= 0 && elapsed <= DIGEST_CATCH_UP_MS;
  const nextRunAt = pendingToday && elapsed <= DIGEST_CATCH_UP_MS
    ? todayAt
    : zonedTimeToUtc(addDays(today, 1), input.timeOfDay, input.timeZone);
  return { due, localDate: today, nextRunAt };
}
