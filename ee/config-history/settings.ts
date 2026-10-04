// SPDX-License-Identifier: Elastic-2.0
/**
 * Configuration history settings, stored under their own settings key. They
 * are not part of the configuration (a restore never turns history off) and
 * are not synced to slaves, which do not record history.
 */
import { eq } from "drizzle-orm";
import { getSetting } from "@/src/lib/settings";
import { settings } from "@/src/lib/db/schema";
import { ApiValidationError } from "@/src/lib/api-errors";
import type { DbTransaction } from "@/src/lib/config-content";
import { first } from "@/src/lib/db/ops";

export const HISTORY_SETTING_KEY = "config_history";
export const DEFAULT_RETENTION = 200;
export const MIN_RETENTION = 1;
export const MAX_RETENTION = 10_000;

export type HistorySettings = {
  /** Record a snapshot after every applied configuration change. */
  enabled: boolean;
  /** How many snapshots to keep; older ones are deleted. */
  retention: number;
};

export const DEFAULT_HISTORY_SETTINGS: HistorySettings = { enabled: false, retention: DEFAULT_RETENTION };

function isValidRetention(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_RETENTION && value <= MAX_RETENTION;
}

export function normalizeHistorySettings(raw: unknown): HistorySettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...DEFAULT_HISTORY_SETTINGS };
  const value = raw as Record<string, unknown>;
  return {
    enabled: value.enabled === true,
    retention: isValidRetention(value.retention) ? value.retention : DEFAULT_RETENTION,
  };
}

export async function getHistorySettings(): Promise<HistorySettings> {
  return normalizeHistorySettings(await getSetting<unknown>(HISTORY_SETTING_KEY));
}

export async function readHistorySettingsInTx(tx: DbTransaction): Promise<HistorySettings> {
  const row = await first(tx.select({ value: settings.value }).from(settings).where(eq(settings.key, HISTORY_SETTING_KEY)).limit(1));
  if (!row) return { ...DEFAULT_HISTORY_SETTINGS };
  try {
    return normalizeHistorySettings(JSON.parse(row.value));
  } catch {
    return { ...DEFAULT_HISTORY_SETTINGS };
  }
}

/** Validates a partial update ({ enabled?, retention? }) and merges it into `current`. */
export function parseHistorySettingsUpdate(input: unknown, current: HistorySettings): HistorySettings {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ApiValidationError("Body must be an object with enabled and/or retention");
  }
  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (key !== "enabled" && key !== "retention") {
      throw new ApiValidationError(`Unknown field "${key}"`);
    }
  }
  if (!("enabled" in body) && !("retention" in body)) {
    throw new ApiValidationError("Body must set enabled and/or retention");
  }
  const next = { ...current };
  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") throw new ApiValidationError("enabled must be a boolean");
    next.enabled = body.enabled;
  }
  if ("retention" in body) {
    if (!isValidRetention(body.retention)) {
      throw new ApiValidationError(`retention must be an integer from ${MIN_RETENTION} to ${MAX_RETENTION}`);
    }
    next.retention = body.retention;
  }
  return next;
}
