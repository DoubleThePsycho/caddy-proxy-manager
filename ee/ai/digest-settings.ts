// SPDX-License-Identifier: Elastic-2.0
/**
 * Daily security digest settings (AI analyst, ee). Stored in the settings
 * table under "ai_digest", with the record of the last run under
 * "ai_digest_state". Neither is synced to slave instances: the digest
 * describes this node's traffic and is sent from here.
 */
import { getSetting, setSetting } from "@/src/lib/settings";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiValidationError } from "@/src/lib/api-errors";
import { requireFeature } from "@/ee/licensing/store";
import { isWindDownOnly } from "@/ee/alerting/gate";
import { getChannelTypes, listAlertChannels } from "@/ee/alerting/channels";
import { isPlainObject, readBoolean, rejectUnknownKeys, requireObject } from "@/ee/alerting/validation";
import { digestSchedule, isValidTimeOfDay, isValidTimeZone } from "./digest-schedule";
import type { DigestDelivery, DigestRunRecord, DigestSettingsView, NarrativeStatus } from "./types";

export const DIGEST_SETTINGS_KEY = "ai_digest";
export const DIGEST_STATE_KEY = "ai_digest_state";
export const MAX_DIGEST_CHANNELS = 20;

export type StoredDigestSettings = {
  enabled: boolean;
  timeOfDay: string;
  timeZone: string;
  channelIds: number[];
  ai: boolean;
  /** When the current schedule took effect; earlier slots are never sent. */
  activeSince: string | null;
};

export type StoredDigestState = {
  /** Local date (in the digest's time zone) of the last scheduled run. */
  lastRunDate: string | null;
  lastRun: DigestRunRecord | null;
};

export const DEFAULT_DIGEST_SETTINGS: StoredDigestSettings = {
  enabled: false,
  timeOfDay: "08:00",
  timeZone: "UTC",
  channelIds: [],
  ai: false,
  activeSince: null,
};

const NARRATIVE_STATUSES: readonly NarrativeStatus[] = ["added", "off", "unavailable", "failed"];

function readIds(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((id): id is number => Number.isInteger(id) && id > 0) : [];
}

export async function readDigestSettings(): Promise<StoredDigestSettings> {
  const value = await getSetting<unknown>(DIGEST_SETTINGS_KEY);
  if (!isPlainObject(value)) return { ...DEFAULT_DIGEST_SETTINGS };
  return {
    enabled: value.enabled === true,
    timeOfDay: typeof value.timeOfDay === "string" && isValidTimeOfDay(value.timeOfDay) ? value.timeOfDay : DEFAULT_DIGEST_SETTINGS.timeOfDay,
    timeZone: typeof value.timeZone === "string" && isValidTimeZone(value.timeZone) ? value.timeZone : DEFAULT_DIGEST_SETTINGS.timeZone,
    channelIds: [...new Set(readIds(value.channelIds))].slice(0, MAX_DIGEST_CHANNELS),
    ai: value.ai === true,
    activeSince: typeof value.activeSince === "string" ? value.activeSince : null,
  };
}

function readDeliveries(value: unknown): DigestDelivery[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPlainObject).map((item) => ({
    channelId: Number(item.channelId),
    channelName: String(item.channelName ?? ""),
    ok: item.ok === true,
    error: typeof item.error === "string" ? item.error : null,
  }));
}

export async function readDigestState(): Promise<StoredDigestState> {
  const value = await getSetting<unknown>(DIGEST_STATE_KEY);
  if (!isPlainObject(value)) return { lastRunDate: null, lastRun: null };
  const run = isPlainObject(value.lastRun) ? value.lastRun : null;
  return {
    lastRunDate: typeof value.lastRunDate === "string" ? value.lastRunDate : null,
    lastRun:
      run && typeof run.at === "string"
        ? {
            at: run.at,
            trigger: run.trigger === "manual" ? "manual" : "scheduled",
            narrative: NARRATIVE_STATUSES.includes(run.narrative as NarrativeStatus) ? (run.narrative as NarrativeStatus) : "off",
            deliveries: readDeliveries(run.deliveries),
          }
        : null,
  };
}

export async function writeDigestState(state: StoredDigestState): Promise<void> {
  await setSetting(DIGEST_STATE_KEY, state);
}

export function toDigestSettingsView(
  settings: StoredDigestSettings,
  state: StoredDigestState,
  existingChannelIds: readonly number[] | null,
  now: Date = new Date()
): DigestSettingsView {
  return {
    enabled: settings.enabled,
    timeOfDay: settings.timeOfDay,
    timeZone: settings.timeZone,
    channelIds: existingChannelIds ? settings.channelIds.filter((id) => existingChannelIds.includes(id)) : settings.channelIds,
    ai: settings.ai,
    nextRunAt: settings.enabled
      ? digestSchedule({ ...settings, lastRunDate: state.lastRunDate }, now).nextRunAt.toISOString()
      : null,
    lastRun: state.lastRun,
  };
}

/** Read-only view; available to administrators without a license. */
export async function getDigestSettingsView(now: Date = new Date()): Promise<DigestSettingsView> {
  const [settings, state, channels] = await Promise.all([readDigestSettings(), readDigestState(), listAlertChannels()]);
  return toDigestSettingsView(settings, state, channels.map((channel) => channel.id), now);
}

function readTimeOfDay(value: unknown): string {
  if (typeof value !== "string" || !isValidTimeOfDay(value.trim())) {
    throw new ApiValidationError('timeOfDay must be a 24-hour time such as "08:00"');
  }
  return value.trim();
}

function readTimeZone(value: unknown): string {
  if (typeof value !== "string" || !isValidTimeZone(value.trim())) {
    throw new ApiValidationError('timeZone must be an IANA time zone such as "Europe/Rome" or "UTC"');
  }
  return value.trim();
}

/** Channels that exist and can carry a digest (PagerDuty pages people and is not used for digests). */
async function readChannelIds(value: unknown): Promise<number[]> {
  if (!Array.isArray(value)) throw new ApiValidationError("channelIds must be an array of alert channel ids");
  if (value.length > MAX_DIGEST_CHANNELS) throw new ApiValidationError(`channelIds may list at most ${MAX_DIGEST_CHANNELS} channels`);
  const ids = value.map((id) => {
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) throw new ApiValidationError("channelIds must be an array of alert channel ids");
    return id;
  });
  const unique = [...new Set(ids)];
  const types = await getChannelTypes(unique);
  for (const id of unique) {
    if (types.get(id) === "pagerduty") {
      throw new ApiValidationError(`Alert channel ${id} is a PagerDuty channel; digests are not sent to PagerDuty`);
    }
  }
  return unique;
}

async function existingIds(ids: readonly number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const channels = await listAlertChannels();
  return ids.filter((id) => channels.some((channel) => channel.id === id && channel.type !== "pagerduty"));
}

/**
 * Validates and stores the digest settings. Needs the ai_analyst feature,
 * except to wind down: a body of only {"enabled": false} and/or {"ai": false}
 * always works.
 */
export async function saveDigestSettings(body: unknown, actorUserId: number, now: Date = new Date()): Promise<DigestSettingsView> {
  const record = requireObject(body, "Request body");
  const windDown = isWindDownOnly(record, { enabled: false, ai: false });
  if (!windDown) await requireFeature("ai_analyst");
  rejectUnknownKeys(record, ["enabled", "timeOfDay", "timeZone", "channelIds", "ai"], "the digest settings");
  const previous = await readDigestSettings();

  let next: StoredDigestSettings;
  if (windDown) {
    next = {
      ...previous,
      enabled: record.enabled === false ? false : previous.enabled,
      ai: record.ai === false ? false : previous.ai,
    };
  } else {
    const enabled = readBoolean(record.enabled, "enabled", previous.enabled);
    const timeOfDay = record.timeOfDay !== undefined ? readTimeOfDay(record.timeOfDay) : previous.timeOfDay;
    const timeZone = record.timeZone !== undefined ? readTimeZone(record.timeZone) : previous.timeZone;
    const channelIds = record.channelIds !== undefined ? await readChannelIds(record.channelIds) : await existingIds(previous.channelIds);
    const ai = readBoolean(record.ai, "ai", previous.ai);
    if (enabled && channelIds.length === 0) throw new ApiValidationError("Choose at least one alert channel for the digest");
    // A schedule that starts (or moves) now never sends a slot that has already passed today.
    const scheduleChanged = enabled && (!previous.enabled || timeOfDay !== previous.timeOfDay || timeZone !== previous.timeZone);
    next = {
      enabled,
      timeOfDay,
      timeZone,
      channelIds,
      ai,
      activeSince: scheduleChanged ? now.toISOString() : previous.activeSince,
    };
  }

  await setSetting(DIGEST_SETTINGS_KEY, next);
  await logAuditEvent({
    userId: actorUserId,
    action: "ai_digest_updated",
    entityType: "ai_digest",
    summary: next.enabled
      ? `Updated the daily security digest (${next.timeOfDay} ${next.timeZone}, ${next.channelIds.length} channel${next.channelIds.length === 1 ? "" : "s"}${next.ai ? ", AI summary" : ""})`
      : "Turned the daily security digest off",
    data: { enabled: next.enabled, timeOfDay: next.timeOfDay, timeZone: next.timeZone, channelIds: next.channelIds, ai: next.ai },
  });
  const state = await readDigestState();
  return toDigestSettingsView(next, state, null, now);
}
