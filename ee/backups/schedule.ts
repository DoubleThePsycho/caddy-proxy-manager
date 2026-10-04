// SPDX-License-Identifier: Elastic-2.0
/**
 * Backup schedules: validation and the next run time, computed in the
 * destination's IANA time zone with Intl (no dependency).
 *
 * Daylight saving time:
 * - a daily or weekly time that does not exist on a day (it falls in the
 *   spring-forward gap) runs once, right after the gap (02:30 becomes 03:30);
 * - a time that occurs twice (fall back) runs once, at its first occurrence;
 * - hourly schedules run every hour that exists: the skipped hour has no run,
 *   the repeated hour runs twice (once per real hour).
 */
import { ApiValidationError } from "@/src/lib/api-errors";
import { DEFAULT_SCHEDULE, SCHEDULE_KINDS, WEEKDAYS, type BackupSchedule, type Weekday } from "./types";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const TIME_ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,3}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTime(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!TIME.test(text)) throw new ApiValidationError("schedule.time must be a time of day as HH:MM (24-hour)");
  return text;
}

/** Validates a schedule; missing input gives the default (daily at 03:00). */
export function parseSchedule(raw: unknown): BackupSchedule {
  if (raw === undefined) return { ...DEFAULT_SCHEDULE };
  if (!isRecord(raw)) throw new ApiValidationError("schedule must be an object");
  const kind = raw.kind;
  if (!(SCHEDULE_KINDS as readonly unknown[]).includes(kind)) {
    throw new ApiValidationError(`schedule.kind must be one of: ${SCHEDULE_KINDS.join(", ")}`);
  }
  const allowed = kind === "hourly" ? ["kind", "minute"] : kind === "daily" ? ["kind", "time"] : ["kind", "day", "time"];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) throw new ApiValidationError(`Unknown field "${key}" in a ${kind} schedule`);
  }
  if (kind === "hourly") {
    const minute = raw.minute ?? 0;
    if (typeof minute !== "number" || !Number.isInteger(minute) || minute < 0 || minute > 59) {
      throw new ApiValidationError("schedule.minute must be a whole number from 0 to 59");
    }
    return { kind, minute };
  }
  if (kind === "daily") return { kind, time: readTime(raw.time) };
  const day = typeof raw.day === "string" ? raw.day.trim().toLowerCase() : raw.day;
  if (!(WEEKDAYS as readonly unknown[]).includes(day)) {
    throw new ApiValidationError(`schedule.day must be one of: ${WEEKDAYS.join(", ")}`);
  }
  return { kind: "weekly", day: day as Weekday, time: readTime(raw.time) };
}

/** A stored schedule; falls back to the default when the stored JSON is unreadable. */
export function readStoredSchedule(value: string): BackupSchedule {
  try {
    return parseSchedule(JSON.parse(value));
  } catch {
    return { ...DEFAULT_SCHEDULE };
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, format);
  }
  return format;
}

/** Validates an IANA time zone name; returns it as given (trimmed). */
export function parseTimeZone(raw: unknown): string {
  if (raw === undefined) return "UTC";
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || text.length > 64 || !TIME_ZONE_NAME.test(text)) {
    throw new ApiValidationError("timeZone must be an IANA time zone such as Europe/Rome or UTC");
  }
  try {
    formatter(text);
    return text;
  } catch {
    throw new ApiValidationError("timeZone must be an IANA time zone such as Europe/Rome or UTC");
  }
}

type Wall = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** The wall-clock time in `timeZone` at instant `ms`. */
export function wallTime(timeZone: string, ms: number): Wall {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function wallAsUtc(wall: Wall): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
}

/** UTC offset of `timeZone` at instant `ms`, in milliseconds (whole seconds). */
function offsetAt(timeZone: string, ms: number): number {
  const whole = Math.floor(ms / 1000) * 1000;
  return wallAsUtc(wallTime(timeZone, whole)) - whole;
}

/**
 * The instants at which the wall clock in `timeZone` shows the given minute:
 * one normally, two when it repeats (fall back), none in a gap (spring
 * forward), in which case `afterGap` is the instant right after the gap.
 */
export function resolveWallTime(
  timeZone: string,
  date: { year: number; month: number; day: number },
  hour: number,
  minute: number
): { instants: number[]; afterGap: number } {
  const wall = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const offsets = new Set([offsetAt(timeZone, wall - DAY_MS), offsetAt(timeZone, wall), offsetAt(timeZone, wall + DAY_MS)]);
  const instants = [...offsets]
    .map((offset) => wall - offset)
    .filter((instant) => {
      const shown = wallTime(timeZone, instant);
      return (
        shown.year === date.year &&
        shown.month === date.month &&
        shown.day === date.day &&
        shown.hour === hour &&
        shown.minute === minute
      );
    })
    .sort((a, b) => a - b);
  // In a gap, the offset in force before the transition puts the time after it.
  return { instants: [...new Set(instants)], afterGap: wall - offsetAt(timeZone, wall - DAY_MS) };
}

function civilDate(ms: number): { year: number; month: number; day: number; weekday: number; hour: number } {
  const date = new Date(ms);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
    hour: date.getUTCHours(),
  };
}

function parseClock(time: string): { hour: number; minute: number } {
  const [hour, minute] = time.split(":").map(Number);
  return { hour, minute };
}

/** The first instant strictly after `after` at which the schedule is due. */
export function nextRunAfter(schedule: BackupSchedule, timeZone: string, after: Date): Date {
  const afterMs = after.getTime();
  const local = wallTime(timeZone, afterMs);
  const localMidnight = Date.UTC(local.year, local.month - 1, local.day);

  if (schedule.kind === "hourly") {
    for (let step = -2; step <= 48; step++) {
      const slot = civilDate(localMidnight + (local.hour + step) * HOUR_MS);
      const { instants } = resolveWallTime(timeZone, slot, slot.hour, schedule.minute);
      const next = instants.find((instant) => instant > afterMs);
      if (next !== undefined) return new Date(next);
    }
  } else {
    const { hour, minute } = parseClock(schedule.time);
    const weekday = schedule.kind === "weekly" ? WEEKDAYS.indexOf(schedule.day) : -1;
    for (let step = -1; step <= 9; step++) {
      const date = civilDate(localMidnight + step * DAY_MS);
      if (weekday >= 0 && date.weekday !== weekday) continue;
      const { instants, afterGap } = resolveWallTime(timeZone, date, hour, minute);
      const instant = instants.length > 0 ? instants[0] : afterGap;
      if (instant > afterMs) return new Date(instant);
    }
  }
  // Unreachable for valid input; never schedule in the past.
  return new Date(afterMs + HOUR_MS);
}
