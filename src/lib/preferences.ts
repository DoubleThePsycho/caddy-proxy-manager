/**
 * Interface preferences of an account: theme (system, dark or light), time
 * zone and number format. They follow the account to every browser; the
 * dashboard formats dates and numbers with them (src/lib/format.ts,
 * src/components/preferences/PreferencesProvider.tsx). Exports, the audit log
 * export and the REST API keep UTC and plain numbers.
 *
 * Per dashboard, like users: not synced to slaves.
 */
import { eq } from "drizzle-orm";
import { appDb, nowIso } from "./db";
import { userPreferences } from "./db/schema";
import { ApiValidationError } from "./api-errors";
import { logAuditEvent } from "./audit";
import {
  DEFAULT_PREFERENCES,
  NUMBER_FORMATS,
  THEMES,
  isNumberFormat,
  isTheme,
  isValidTimeZone,
  type UserPreferences,
} from "./preferences-shared";
import { first } from "@/src/lib/db/ops";

export type { UserPreferences } from "./preferences-shared";

/** The account's preferences; the defaults (system theme, UTC, en-US) when it has none. */
export async function getUserPreferences(userId: number): Promise<UserPreferences> {
  const row = await first(appDb.select().from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1));
  if (!row) return { ...DEFAULT_PREFERENCES };
  // Values that are no longer valid (a time zone the runtime does not know) fall back to the default.
  return {
    theme: isTheme(row.theme) ? row.theme : DEFAULT_PREFERENCES.theme,
    timeZone: isValidTimeZone(row.timeZone) ? row.timeZone : DEFAULT_PREFERENCES.timeZone,
    numberFormat: isNumberFormat(row.numberFormat) ? row.numberFormat : DEFAULT_PREFERENCES.numberFormat,
  };
}

/** Reads a change: any of theme, timeZone and numberFormat; unknown fields are refused. */
export function parsePreferencesInput(body: unknown): Partial<UserPreferences> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiValidationError("Request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "theme" && key !== "timeZone" && key !== "numberFormat") {
      throw new ApiValidationError(`Unknown field "${key.slice(0, 40)}"`);
    }
  }
  const input: Partial<UserPreferences> = {};
  if (record.theme !== undefined) {
    if (!isTheme(record.theme)) throw new ApiValidationError(`theme must be one of ${THEMES.join(", ")}`);
    input.theme = record.theme;
  }
  if (record.timeZone !== undefined) {
    if (!isValidTimeZone(record.timeZone)) throw new ApiValidationError("timeZone must be an IANA time zone, such as UTC or Europe/Rome");
    input.timeZone = record.timeZone;
  }
  if (record.numberFormat !== undefined) {
    if (!isNumberFormat(record.numberFormat)) {
      throw new ApiValidationError(`numberFormat must be one of ${NUMBER_FORMATS.join(", ")}`);
    }
    input.numberFormat = record.numberFormat;
  }
  return input;
}

/** Saves a change of the account's own preferences, recorded in the audit log. */
export async function updateUserPreferences(userId: number, input: Partial<UserPreferences>): Promise<UserPreferences> {
  // Read, merge and write in one transaction: two changes made together both stay.
  return await appDb.transaction(async (tx) => {
    const previous = await getUserPreferences(userId);
    const next = { ...previous, ...input };
    const changed = (Object.keys(input) as Array<keyof UserPreferences>).filter((key) => previous[key] !== next[key]);
    const now = nowIso();
    await tx.insert(userPreferences)
      .values({ userId, ...next, updatedAt: now })
      .onConflictDoUpdate({ target: userPreferences.userId, set: { ...next, updatedAt: now } });
    if (changed.length > 0) {
      await logAuditEvent({
        userId,
        action: "preferences_updated",
        entityType: "user",
        entityId: userId,
        summary: `Changed their interface preferences: ${changed.join(", ")}`,
        data: Object.fromEntries(changed.map((key) => [key, next[key]])),
      });
    }
    return next;
  }, { behavior: "immediate" });
}

/** Whether the account has saved preferences (the theme then follows the account to every browser). */
export async function hasSavedPreferences(userId: number): Promise<boolean> {
  return !!await first(appDb.select({ userId: userPreferences.userId }).from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1));
}
