// SPDX-License-Identifier: Elastic-2.0
/**
 * The incident register: every security event is recorded with its window,
 * a timeline, the NIS2 Article 23 significance assessment, a classification
 * a person makes, and the cause. A significant incident gets the
 * notification drafts of incidents.ts with their deadlines. Pure functions
 * and data; safe to import from client components.
 *
 * Article 23(3): an incident is significant if it has caused or is capable of
 * causing severe operational disruption of the services or financial loss
 * for the entity, or has affected or is capable of affecting other natural
 * or legal persons by causing considerable material or non-material damage.
 * The two other questions are what the early warning must say (Art. 23(4)(a)).
 */
import type { ChoiceValue, IncidentFacts } from "./types";

export const CLASSIFICATIONS = ["undetermined", "not_significant", "significant"] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const CLASSIFICATION_LABELS: Record<Classification, string> = {
  undetermined: "Not assessed yet",
  not_significant: "Not significant",
  significant: "Significant",
};

export type AssessmentKey = "severeDisruption" | "considerableDamage" | "suspectedMalicious" | "crossBorderImpact";

export type AssessmentQuestion = {
  key: AssessmentKey;
  question: string;
  legalBasis: string;
  /** Whether the answer decides significance (Art. 23(3)); the others go into the early warning. */
  decides: boolean;
};

export const ASSESSMENT_QUESTIONS: readonly AssessmentQuestion[] = [
  {
    key: "severeDisruption",
    question: "Has it caused, or can it cause, severe operational disruption of the services or financial loss?",
    legalBasis: "NIS2 Art. 23(3)(a)",
    decides: true,
  },
  {
    key: "considerableDamage",
    question: "Has it affected, or can it affect, other people or organisations by causing considerable material or non-material damage?",
    legalBasis: "NIS2 Art. 23(3)(b)",
    decides: true,
  },
  {
    key: "suspectedMalicious",
    question: "Is it suspected of being caused by unlawful or malicious acts?",
    legalBasis: "NIS2 Art. 23(4)(a)",
    decides: false,
  },
  {
    key: "crossBorderImpact",
    question: "Could it have a cross-border impact?",
    legalBasis: "NIS2 Art. 23(4)(a)",
    decides: false,
  },
];

export const ASSESSMENT_KEYS: readonly AssessmentKey[] = ASSESSMENT_QUESTIONS.map((question) => question.key);

export type AssessmentAnswer = { answer: ChoiceValue; reason: string };
export type IncidentAssessment = Record<AssessmentKey, AssessmentAnswer>;

export const MAX_REASON_CHARS = 1000;
export const MAX_CAUSE_CHARS = 8000;
export const MAX_TIMELINE_ENTRIES = 100;
export const MAX_TIMELINE_TEXT = 500;

export function emptyAssessment(): IncidentAssessment {
  return Object.fromEntries(ASSESSMENT_KEYS.map((key) => [key, { answer: "unknown", reason: "" }])) as IncidentAssessment;
}

/** What the answers suggest; the classification itself is always a person's decision. */
export function suggestedClassification(assessment: IncidentAssessment): Classification {
  const decisive = ASSESSMENT_QUESTIONS.filter((question) => question.decides).map((question) => assessment[question.key].answer);
  if (decisive.includes("yes")) return "significant";
  if (decisive.every((answer) => answer === "no")) return "not_significant";
  return "undetermined";
}

export type TimelineEntry = {
  at: string;
  text: string;
  /** person: added by someone; facts: from the facts collected for the incident. */
  source: "person" | "facts";
};

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Timeline entries derived from the collected facts (aggregated figures only). */
export function factsTimeline(facts: IncidentFacts | null, detectedAt: string): TimelineEntry[] {
  const entries: TimelineEntry[] = [{ at: detectedAt, text: "Became aware of the incident; the notification deadlines run from here.", source: "facts" }];
  if (!facts) return entries;
  if (facts.waf?.firstEventAt) {
    entries.push({ at: facts.waf.firstEventAt, text: `First WAF event in the period (${plural(facts.waf.events, "event")}, ${facts.waf.blocked} blocked).`, source: "facts" });
  }
  if (facts.waf?.peakHour) {
    entries.push({ at: facts.waf.peakHour.at, text: `Busiest hour for the WAF: ${plural(facts.waf.peakHour.events, "event")}.`, source: "facts" });
  }
  if (facts.waf?.lastEventAt && facts.waf.lastEventAt !== facts.waf.firstEventAt) {
    entries.push({ at: facts.waf.lastEventAt, text: "Last WAF event in the period.", source: "facts" });
  }
  for (const alert of facts.alerts?.recent ?? []) {
    entries.push({ at: alert.at, text: `Alert "${alert.title}" ${alert.status === "resolved" ? "resolved" : "fired"} (${alert.severity}).`, source: "facts" });
  }
  if (facts.sourceAlert && !(facts.alerts?.recent ?? []).some((alert) => alert.id === facts.sourceAlert!.id)) {
    entries.push({ at: facts.sourceAlert.at, text: `Alert "${facts.sourceAlert.title}" ${facts.sourceAlert.status === "resolved" ? "resolved" : "fired"} (${facts.sourceAlert.severity}).`, source: "facts" });
  }
  for (const change of facts.configChanges?.recent ?? []) {
    entries.push({ at: change.at, text: `Configuration change by ${change.actor}: ${change.summary}`, source: "facts" });
  }
  return entries;
}

/** Person-added and fact entries together, oldest first. */
export function mergeTimeline(own: TimelineEntry[], facts: TimelineEntry[]): TimelineEntry[] {
  return [...own, ...facts].sort((a, b) => a.at.localeCompare(b.at) || (a.source === b.source ? 0 : a.source === "facts" ? -1 : 1));
}

export type NotificationStatus = "undetermined" | "not_required" | "required" | "submitted";

export const NOTIFICATION_STATUS_LABELS: Record<NotificationStatus, string> = {
  undetermined: "Depends on the assessment",
  not_required: "Not required",
  required: "Required",
  submitted: "Submitted",
};
