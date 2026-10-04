/**
 * When the usage ping goes out: a few minutes after it is turned on, then
 * once a day at a minute of the UTC day picked at random (so installs do not
 * all send at once). Pure date arithmetic.
 */
import { randomInt } from "node:crypto";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Two attempts are at least this far apart (the receiving service keeps one ping per install per 12 hours). */
export const MIN_ATTEMPT_SPACING_MS = 12 * 60 * MINUTE_MS;
/** After it is turned on, the first ping goes out between one and five minutes later. */
export const FIRST_PING_DELAY_MS = { min: MINUTE_MS, max: 5 * MINUTE_MS } as const;

export const MINUTES_PER_DAY = 24 * 60;

export function randomMinuteOfDay(): number {
  return randomInt(MINUTES_PER_DAY);
}

export function isMinuteOfDay(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < MINUTES_PER_DAY;
}

/** Shortly after the ping is turned on. */
export function firstAttemptAfterOptIn(now: Date): Date {
  return new Date(now.getTime() + randomInt(FIRST_PING_DELAY_MS.min, FIRST_PING_DELAY_MS.max + 1));
}

/**
 * The first time at `minuteOfDay` (UTC) at least MIN_ATTEMPT_SPACING_MS
 * after `after`: the next daily slot, between 12 and 36 hours away. A failed
 * attempt is not retried sooner.
 */
export function nextDailyAttempt(minuteOfDay: number, after: Date): Date {
  const earliest = after.getTime() + MIN_ATTEMPT_SPACING_MS;
  const day = new Date(earliest);
  const slot = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) + minuteOfDay * MINUTE_MS;
  return new Date(slot >= earliest ? slot : slot + DAY_MS);
}
