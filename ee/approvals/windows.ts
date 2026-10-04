// SPDX-License-Identifier: Elastic-2.0
/**
 * Change windows: when a policy lets approved changes be applied. A window
 * is a range of wall-clock time on some weekdays in the policy's IANA time
 * zone; a window whose end is not after its start runs past midnight into
 * the next day (its days name the day it starts). Uses Intl only, so the
 * dashboard can show the same answers the scheduler acts on.
 *
 * Daylight saving time follows the wall clock:
 * - a window inside the skipped hour of a spring-forward night is never open
 *   that night (02:00–03:00 does not exist); one that overlaps it opens at
 *   the first minute that exists (02:30–04:00 opens at 03:00);
 * - a window inside the repeated hour of a fall-back night is open for both
 *   occurrences (02:00–03:00 lasts two real hours).
 */
import { ApiValidationError } from "@/src/lib/api-errors";
import { parseTimeZone, resolveWallTime, wallTime } from "@/ee/backups/schedule";
import { WEEKDAYS, type Weekday } from "@/ee/backups/types";
import { MAX_WINDOWS, type ChangeWindow } from "./types";

const START = /^([01]\d|2[0-3]):([0-5]\d)$/;
const END = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Monday first, for display and storage order. */
const WEEK_ORDER: readonly Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const SHORT_DAY: Record<Weekday, string> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Minutes after midnight; "24:00" is 1440. */
export function minutesOf(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function parseWindow(raw: unknown, index: number): ChangeWindow {
  const where = `windows[${index}]`;
  if (!isRecord(raw)) throw new ApiValidationError(`${where} must be an object with days, start and end`);
  for (const key of Object.keys(raw)) {
    if (!["days", "start", "end"].includes(key)) throw new ApiValidationError(`Unknown field "${key}" in ${where}`);
  }
  if (!Array.isArray(raw.days) || raw.days.length === 0) {
    throw new ApiValidationError(`${where}.days must list at least one weekday`);
  }
  const days = new Set<Weekday>();
  for (const day of raw.days) {
    const name = typeof day === "string" ? day.trim().toLowerCase() : day;
    if (!(WEEKDAYS as readonly unknown[]).includes(name)) {
      throw new ApiValidationError(`${where}.days must contain weekday names: ${WEEK_ORDER.join(", ")}`);
    }
    days.add(name as Weekday);
  }
  const start = typeof raw.start === "string" ? raw.start.trim() : "";
  const end = typeof raw.end === "string" ? raw.end.trim() : "";
  if (!START.test(start)) throw new ApiValidationError(`${where}.start must be a time of day as HH:MM (24-hour)`);
  if (!END.test(end)) throw new ApiValidationError(`${where}.end must be a time of day as HH:MM (24-hour) or 24:00`);
  if (minutesOf(start) === minutesOf(end) % 1440 && end !== "24:00") {
    throw new ApiValidationError(`${where} must not start and end at the same time; use 00:00 to 24:00 for a whole day`);
  }
  return { days: WEEK_ORDER.filter((day) => days.has(day)), start, end };
}

/** Validates change windows; missing input means no restriction. */
export function parseWindows(raw: unknown): ChangeWindow[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ApiValidationError("windows must be an array");
  if (raw.length > MAX_WINDOWS) throw new ApiValidationError(`A policy can have at most ${MAX_WINDOWS} change windows`);
  return raw.map(parseWindow);
}

/** Windows as stored; anything unreadable is dropped (an unreadable list counts as no window). */
export function readStoredWindows(value: string | null | undefined): ChangeWindow[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const windows: ChangeWindow[] = [];
    parsed.forEach((item, index) => {
      try {
        windows.push(parseWindow(item, index));
      } catch {
        // Skipped: never widen a window that cannot be read.
      }
    });
    // A list that had windows but none readable must not become "any time".
    return parsed.length > 0 && windows.length === 0 ? [{ days: [], start: "00:00", end: "00:01" }] : windows;
  } catch {
    return [];
  }
}

export { parseTimeZone };

type Rule = { windows: readonly ChangeWindow[]; timeZone: string };

/** The local weekday and minute of the day at `ms`. */
function localPosition(timeZone: string, ms: number): { weekday: number; minute: number } {
  const wall = wallTime(timeZone, ms);
  const weekday = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
  return { weekday, minute: wall.hour * 60 + wall.minute };
}

function dayIndex(day: Weekday): number {
  return WEEKDAYS.indexOf(day);
}

/** Whether `at` falls in one of the windows (always, when there are none). */
export function isWindowOpenAt(windows: readonly ChangeWindow[], timeZone: string, at: Date): boolean {
  if (windows.length === 0) return true;
  const { weekday, minute } = localPosition(timeZone, at.getTime());
  const previous = (weekday + 6) % 7;
  return windows.some((window) => {
    const start = minutesOf(window.start);
    const end = minutesOf(window.end);
    const days = window.days.map(dayIndex);
    if (end > start) return days.includes(weekday) && minute >= start && minute < end;
    // Past midnight: the evening part on its days, the morning part on the day after.
    return (days.includes(weekday) && minute >= start) || (days.includes(previous) && minute < end);
  });
}

/** Whether every rule's windows are open at `at`. */
export function allWindowsOpenAt(rules: readonly Rule[], at: Date): boolean {
  return rules.every((rule) => isWindowOpenAt(rule.windows, rule.timeZone, at));
}

/** Instants (after `afterMs`, within nine days) at which one of the rule's windows starts. */
function windowStarts(rule: Rule, afterMs: number): number[] {
  const local = wallTime(rule.timeZone, afterMs);
  const midnight = Date.UTC(local.year, local.month - 1, local.day);
  const starts: number[] = [];
  for (let step = -1; step <= 8; step++) {
    const date = new Date(midnight + step * DAY_MS);
    const civil = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
    for (const window of rule.windows) {
      if (!window.days.map(dayIndex).includes(date.getUTCDay())) continue;
      const minutes = minutesOf(window.start);
      const { instants, afterGap } = resolveWallTime(rule.timeZone, civil, Math.floor(minutes / 60), minutes % 60);
      let candidates = instants;
      if (instants.length === 0) {
        // The start falls in a spring-forward gap: the window opens with the first minute after it.
        let instant = afterGap;
        for (let step = 0; step < 180 && isWindowOpenAt(rule.windows, rule.timeZone, new Date(instant - MINUTE_MS)); step++) {
          instant -= MINUTE_MS;
        }
        candidates = [instant];
      }
      for (const instant of candidates) {
        if (instant > afterMs) starts.push(instant);
      }
    }
  }
  return starts;
}

/**
 * The first instant at or after `after` when every rule's windows are open,
 * or null when they never overlap in the coming week.
 */
export function nextOpening(rules: readonly Rule[], after: Date): Date | null {
  const restricted = rules.filter((rule) => rule.windows.length > 0);
  if (allWindowsOpenAt(restricted, after)) return after;
  const candidates = [...new Set(restricted.flatMap((rule) => windowStarts(rule, after.getTime())))].sort((a, b) => a - b);
  const found = candidates.find((instant) => allWindowsOpenAt(restricted, new Date(instant)));
  return found === undefined ? null : new Date(found);
}

function describeDays(days: readonly Weekday[]): string {
  const indexes = days.map((day) => WEEK_ORDER.indexOf(day)).sort((a, b) => a - b);
  const parts: string[] = [];
  let runStart = 0;
  for (let i = 1; i <= indexes.length; i++) {
    if (i < indexes.length && indexes[i] === indexes[i - 1] + 1) continue;
    const run = indexes.slice(runStart, i);
    const label = (index: number) => SHORT_DAY[WEEK_ORDER[index]];
    parts.push(run.length >= 3 ? `${label(run[0])}–${label(run[run.length - 1])}` : run.map(label).join(", "));
    runStart = i;
  }
  return parts.join(", ");
}

/** e.g. "Mon–Fri 09:00–17:00, Sat 22:00–02:00 (Europe/Rome)"; null when unrestricted. */
export function describeWindows(windows: readonly ChangeWindow[], timeZone: string): string | null {
  if (windows.length === 0) return null;
  return `${windows.map((window) => `${describeDays(window.days)} ${window.start}–${window.end}`).join(", ")} (${timeZone})`;
}
