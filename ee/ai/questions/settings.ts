// SPDX-License-Identifier: Elastic-2.0
/**
 * Plain-language analytics questions: their settings, stored in the settings
 * table under "ai_questions". Not synced to slave instances, like the AI
 * provider they use: questions are asked on the dashboard that holds the
 * provider.
 *
 * - enabled (default true): users who can read analytics may ask, when an AI
 *   provider is configured.
 * - aiSummaries (default true): the model writes a short summary from the
 *   aggregated result; off, the dashboard writes it and the result never
 *   reaches the model.
 * - shareRequestDetails (default false): client addresses, user agents and
 *   paths reach the model when a question ranks or filters by them;
 *   otherwise they are placeholders.
 */
import { getSetting, setSetting } from "@/src/lib/settings";
import { logAuditEvent } from "@/src/lib/audit";
import { isPlainObject, readBoolean, rejectUnknownKeys, requireObject } from "@/ee/alerting/validation";
import type { QuestionSettingsView } from "./types";

export const QUESTION_SETTINGS_KEY = "ai_questions";

export const DEFAULT_QUESTION_SETTINGS: QuestionSettingsView = {
  enabled: true,
  aiSummaries: true,
  shareRequestDetails: false,
};

const FIELDS = ["enabled", "aiSummaries", "shareRequestDetails"] as const;

export async function getQuestionSettings(): Promise<QuestionSettingsView> {
  const value = await getSetting<unknown>(QUESTION_SETTINGS_KEY);
  if (!isPlainObject(value)) return { ...DEFAULT_QUESTION_SETTINGS };
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_QUESTION_SETTINGS.enabled,
    aiSummaries: typeof value.aiSummaries === "boolean" ? value.aiSummaries : DEFAULT_QUESTION_SETTINGS.aiSummaries,
    shareRequestDetails: value.shareRequestDetails === true,
  };
}

/** Partial update. */
export async function saveQuestionSettings(body: unknown, actorUserId: number): Promise<QuestionSettingsView> {
  const record = requireObject(body, "Request body");
  rejectUnknownKeys(record, FIELDS, "the question settings");
  const previous = await getQuestionSettings();
  const next: QuestionSettingsView = {
    enabled: readBoolean(record.enabled, "enabled", previous.enabled),
    aiSummaries: readBoolean(record.aiSummaries, "aiSummaries", previous.aiSummaries),
    shareRequestDetails: readBoolean(record.shareRequestDetails, "shareRequestDetails", previous.shareRequestDetails),
  };
  await setSetting(QUESTION_SETTINGS_KEY, next);
  const changed = FIELDS.filter((field) => next[field] !== previous[field]);
  await logAuditEvent({
    userId: actorUserId,
    action: "ai_question_settings_updated",
    entityType: "ai_settings",
    summary: `Updated the analytics question settings (${next.enabled ? "on" : "off"}${next.aiSummaries ? ", AI summaries" : ""}${next.shareRequestDetails ? ", request details sent" : ""})`,
    data: { ...next, changed },
  });
  return next;
}
