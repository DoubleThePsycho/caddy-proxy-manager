// SPDX-License-Identifier: Elastic-2.0
/**
 * NIS2 Article 23 notification stages, their fields and deadlines. Pure
 * functions and data; safe to import from client components.
 *
 * Deadlines run from when the organisation became aware of the significant
 * incident: early warning within 24 hours, incident notification within 72
 * hours, final report within one month of the incident notification. In
 * Italy, D.Lgs. 138/2024 (Art. 25) sets the same stages, and notifications go
 * to CSIRT Italia at ACN.
 */
import type { DeadlineStatus, IncidentStageKey, StoredIncidentStage } from "./types";

export type StageField = { key: string; label: string; kind: "text" | "choice"; guidance: string };

export type StageDefinition = {
  key: IncidentStageKey;
  label: string;
  legalBasis: string;
  deadlineRule: string;
  /** What the stage must contain, paraphrasing Article 23(4). */
  requirement: string;
  fields: StageField[];
};

export const INCIDENT_STAGES: readonly StageDefinition[] = [
  {
    key: "early_warning",
    label: "Early warning",
    legalBasis: "NIS2 Art. 23(4)(a)",
    deadlineRule: "Within 24 hours of becoming aware of the significant incident",
    requirement:
      "Without undue delay and in any event within 24 hours of becoming aware of the significant incident. It indicates, where applicable, whether the incident is suspected of being caused by unlawful or malicious acts and whether it could have a cross-border impact.",
    fields: [
      { key: "summary", label: "What happened", kind: "text", guidance: "A short description of the incident as known now." },
      { key: "suspectedMalicious", label: "Suspected to be caused by unlawful or malicious acts", kind: "choice", guidance: "Your assessment; leave unknown until you can tell." },
      { key: "crossBorderImpact", label: "Could have a cross-border impact", kind: "choice", guidance: "Your assessment; leave unknown until you can tell." },
      { key: "actionsTaken", label: "First actions taken", kind: "text", guidance: "Containment and first response so far." },
    ],
  },
  {
    key: "notification",
    label: "Incident notification",
    legalBasis: "NIS2 Art. 23(4)(b)",
    deadlineRule: "Within 72 hours of becoming aware of the significant incident",
    requirement:
      "Without undue delay and in any event within 72 hours of becoming aware of the significant incident. It updates the early warning and gives an initial assessment of the incident, including its severity and impact, and indicators of compromise where available.",
    fields: [
      { key: "update", label: "Update to the early warning", kind: "text", guidance: "What is new since the early warning." },
      { key: "assessment", label: "Initial assessment: severity and impact", kind: "text", guidance: "Severity, affected services and users, duration." },
      { key: "indicatorsOfCompromise", label: "Indicators of compromise", kind: "text", guidance: "Where available: addresses, domains, request patterns, file hashes." },
      { key: "mitigation", label: "Measures taken so far", kind: "text", guidance: "Containment, eradication and recovery steps." },
    ],
  },
  {
    key: "final_report",
    label: "Final report",
    legalBasis: "NIS2 Art. 23(4)(d)",
    deadlineRule: "Within one month of submitting the incident notification",
    requirement:
      "Not later than one month after the incident notification. It contains a detailed description of the incident, including its severity and impact; the type of threat or root cause that is likely to have triggered it; applied and ongoing mitigation measures; and, where applicable, the cross-border impact. If the incident is still ongoing then, a progress report is due instead, and the final report within one month of handling the incident.",
    fields: [
      { key: "description", label: "Detailed description, severity and impact", kind: "text", guidance: "The full account of the incident." },
      { key: "rootCause", label: "Type of threat or root cause", kind: "text", guidance: "What most likely triggered the incident." },
      { key: "mitigation", label: "Applied and ongoing mitigation measures", kind: "text", guidance: "What was done and what is still in progress." },
      { key: "crossBorderImpact", label: "Cross-border impact", kind: "text", guidance: "Where applicable." },
    ],
  },
];

export const STAGE_KEYS: readonly IncidentStageKey[] = INCIDENT_STAGES.map((stage) => stage.key);

export function isStageKey(value: unknown): value is IncidentStageKey {
  return typeof value === "string" && (STAGE_KEYS as readonly string[]).includes(value);
}

export function stageDefinition(key: IncidentStageKey): StageDefinition {
  return INCIDENT_STAGES.find((stage) => stage.key === key)!;
}

export const MAX_FIELD_CHARS = 8000;
export const MAX_REFERENCE_CHARS = 200;

const HOUR_MS = 60 * 60 * 1000;

/** The same day of the next month in UTC, or the last day of that month when it is shorter. */
export function addOneMonthUtc(date: Date): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

/**
 * The deadline of a stage. The final report's runs from when the incident
 * notification was submitted; until that is recorded, from its 72-hour
 * deadline (the latest it can have been due).
 */
export function stageDeadline(key: IncidentStageKey, detectedAt: Date, notificationSubmittedAt: Date | null): Date {
  if (key === "early_warning") return new Date(detectedAt.getTime() + 24 * HOUR_MS);
  if (key === "notification") return new Date(detectedAt.getTime() + 72 * HOUR_MS);
  return addOneMonthUtc(notificationSubmittedAt ?? new Date(detectedAt.getTime() + 72 * HOUR_MS));
}

export function deadlineStatus(stage: Pick<StoredIncidentStage, "submittedAt">, deadline: Date, now: Date): DeadlineStatus {
  if (stage.submittedAt) return "submitted";
  return now.getTime() > deadline.getTime() ? "overdue" : "open";
}

export function emptyStage(key: IncidentStageKey): StoredIncidentStage {
  const fields: Record<string, string> = {};
  for (const field of stageDefinition(key).fields) fields[field.key] = field.kind === "choice" ? "unknown" : "";
  return { fields, ai: null, editedAt: null, submittedAt: null, reference: null };
}
