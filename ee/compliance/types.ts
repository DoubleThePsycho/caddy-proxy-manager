// SPDX-License-Identifier: Elastic-2.0
/**
 * Compliance reports: shared types and constants. Safe to import from client
 * components (no server-only dependencies).
 */
import type { Classification, IncidentAssessment, NotificationStatus, TimelineEntry } from "./incident-register";
import type { QuestionQuery } from "@/ee/ai/questions/types";

export const COMPLIANCE_TABS = ["overview", "reports", "mapping"] as const;
export type ComplianceTab = (typeof COMPLIANCE_TABS)[number];

/** The tab a ?tab= value opens; the names of the earlier tabs still work. */
export function readComplianceTab(value: string | undefined): ComplianceTab {
  if (value === "controls") return "mapping";
  if (value === "incidents") return "overview";
  return COMPLIANCE_TABS.find((tab) => tab === value) ?? "overview";
}

/** The framework the page's control references are shown for. */
export const COMPLIANCE_FRAMEWORKS = ["nis2", "iso27001"] as const;
export type ComplianceFramework = (typeof COMPLIANCE_FRAMEWORKS)[number];

export function readComplianceFramework(value: string | undefined): ComplianceFramework {
  return value === "iso27001" || value === "iso" ? "iso27001" : "nis2";
}

export const REPORT_TYPES = ["access_review", "change_log", "certificate_inventory", "protection_coverage", "traffic_questions"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/**
 * The reports a person picks, to generate one or for a schedule. "Traffic
 * questions" is not among them: a schedule adds it when saved analytics
 * questions are part of it (ee/ai/questions).
 */
export const SELECTABLE_REPORT_TYPES = ["access_review", "change_log", "certificate_inventory", "protection_coverage"] as const;
export type SelectableReportType = (typeof SELECTABLE_REPORT_TYPES)[number];

export function isSelectableReportType(value: unknown): value is SelectableReportType {
  return typeof value === "string" && (SELECTABLE_REPORT_TYPES as readonly string[]).includes(value);
}

export const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  access_review: "Access review",
  change_log: "Change log",
  certificate_inventory: "Certificate inventory",
  protection_coverage: "Protection coverage",
  traffic_questions: "Traffic questions",
};

export const REPORT_TYPE_DESCRIPTIONS: Record<ReportType, string> = {
  access_review:
    "Every dashboard user with role, permissions, tag scope, status, MFA, last sign-in, SSO identities, API tokens and forward-auth groups. Flags administrators without MFA, accounts inactive for more than 90 days and tokens unused for 90 days.",
  change_log:
    "Audit events of the period grouped by area and actor, with the result of the audit log's hash-chain verification.",
  certificate_inventory:
    "Every certificate with issuer, subject and SANs, key type, expiry, how it is managed and the hosts using it. Flags expired and expiring certificates.",
  protection_coverage:
    "Which hosts have the WAF (and its mode), access lists, forward auth, mTLS, geo blocking, HTTPS redirects and HSTS, and the MFA coverage of users.",
  traffic_questions:
    "The saved analytics questions of a report schedule, re-run for the period over every host: one table per question, from aggregated traffic figures.",
};

export function isReportType(value: unknown): value is ReportType {
  return typeof value === "string" && (REPORT_TYPES as readonly string[]).includes(value);
}

/**
 * A saved analytics question copied into a report schedule (ee/ai/questions):
 * the question as typed and its validated query. Each run re-runs it for the
 * period in the "Traffic questions" report. `savedQuestionId` names the saved
 * question it was copied from, which may since have been deleted.
 */
export type ScheduleQuestion = { savedQuestionId: number | null; question: string; query: QuestionQuery };

export type ScheduleQuestionView = {
  savedQuestionId: number | null;
  question: string;
  /** The query in words, with its own range (each run uses the report's period instead). */
  interpretation: string;
};

export const FINDING_SEVERITIES = ["high", "medium", "low", "info"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** One value of a report table. Lists stay lists in JSON and are joined with "; " in CSV. */
export type ReportCell = string | number | boolean | null | string[];

export type ReportColumn = { key: string; label: string };

export type ReportSection = {
  key: string;
  title: string;
  description: string | null;
  columns: ReportColumn[];
  rows: Record<string, ReportCell>[];
  /** Set when only the first `shown` of `total` rows are included. */
  truncated: { shown: number; total: number } | null;
};

export type ReportFinding = {
  severity: FindingSeverity;
  code: string;
  /** What the finding is about, e.g. "user:3" or "certificate:7". */
  subject: string;
  message: string;
};

export type ReportSummaryItem = { key: string; label: string; value: string | number | boolean | null };

export type ControlFramework = "NIS2" | "ISO/IEC 27001:2022";

export type ControlReference = {
  framework: ControlFramework;
  /** "Art. 21(2)(i)" or "A.5.15" */
  ref: string;
  title: string;
  /** How the report supports the control. */
  how: string;
};

/** The report as generated, stored and hashed (the integrity block is added on export). */
export type ComplianceReportDocument = {
  format: "compliance-report";
  formatVersion: 1;
  reportId: string;
  type: ReportType;
  title: string;
  period: { from: string; to: string };
  generatedAt: string;
  /** userId null: generated by a report schedule (name says which). */
  generatedBy: { userId: number | null; name: string | null; email: string | null };
  product: { name: string; version: string };
  instanceMode: string;
  statement: string;
  controls: ControlReference[];
  summary: ReportSummaryItem[];
  findings: ReportFinding[];
  sections: ReportSection[];
  notes: string[];
};

export type FindingCounts = Record<FindingSeverity, number>;

export type StoredReportSummary = {
  id: number;
  reportId: string;
  type: ReportType;
  title: string;
  period: { from: string; to: string };
  generatedAt: string;
  generatedBy: { userId: number | null; name: string | null };
  sha256: string;
  findings: FindingCounts;
  sizeBytes: number;
  /** The schedule that generated it, and the run (evidence pack) it belongs to; null when generated by hand. */
  scheduleId: number | null;
  packId: string | null;
};

export type ReportIntegrity = {
  algorithm: "SHA-256";
  canonicalization: string;
  sha256: string;
  /** The stored content still hashes to the stored SHA-256. */
  contentMatches: boolean;
  /** The audit event recorded at generation, and whether its SHA-256 matches. */
  auditEvent: { id: number; recordedAt: string; sha256Matches: boolean } | null;
};

export type StoredReportDetail = StoredReportSummary & {
  document: ComplianceReportDocument;
  integrity: ReportIntegrity;
};

export type ReportListPage = { reports: StoredReportSummary[]; total: number; page: number; perPage: number };

// ── Incident notification drafts ─────────────────────────────────────────

export const INCIDENT_LANGUAGES = ["en", "it"] as const;
export type IncidentLanguage = (typeof INCIDENT_LANGUAGES)[number];
export const INCIDENT_LANGUAGE_LABELS: Record<IncidentLanguage, string> = { en: "English", it: "Italiano" };

export const INCIDENT_STATUSES = ["open", "closed"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const CHOICE_VALUES = ["unknown", "yes", "no"] as const;
export type ChoiceValue = (typeof CHOICE_VALUES)[number];

export type IncidentStageKey = "early_warning" | "notification" | "final_report";

export type IncidentStageAi = { generatedAt: string; provider: string; model: string };

export type StoredIncidentStage = {
  fields: Record<string, string>;
  /** Set when the configured AI provider wrote the current draft text. */
  ai: IncidentStageAi | null;
  /** Last time a person changed the stage's text. */
  editedAt: string | null;
  /** When the person submitted this stage to the CSIRT or authority (recorded, never sent from here). */
  submittedAt: string | null;
  /** The CSIRT's or authority's reference for the submission. */
  reference: string | null;
};

export type DeadlineStatus = "submitted" | "overdue" | "open";

export type IncidentStageView = StoredIncidentStage & {
  key: IncidentStageKey;
  label: string;
  legalBasis: string;
  deadline: string;
  deadlineRule: string;
  status: DeadlineStatus;
};

export type IncidentFacts = {
  period: { from: string; to: string };
  becameAwareAt: string;
  scope: { allHosts: boolean; proxyHosts: { id: number; name: string; domains: string[] }[] };
  analytics: { status: "ok" | "disabled" | "error"; note: string | null };
  traffic: {
    requests: number;
    uniqueClients: number;
    statusClasses: { "2xx": number; "3xx": number; "4xx": number; "5xx": number };
    geoBlocked: number;
  } | null;
  waf: {
    events: number;
    blocked: number;
    detectedOnly: number;
    firstEventAt: string | null;
    lastEventAt: string | null;
    peakHour: { at: string; events: number } | null;
    topRules: { ruleId: number; message: string | null; events: number }[];
    topHosts: { host: string; events: number }[];
    topPaths: { host: string; path: string; events: number }[];
    topCountries: { country: string; events: number }[];
  } | null;
  sourceAlert: {
    id: number;
    at: string;
    ruleName: string;
    ruleType: string;
    severity: string;
    status: string;
    title: string;
    message: string;
  } | null;
  alerts: { total: number; recent: { id: number; at: string; ruleType: string; severity: string; status: string; title: string }[] };
  configChanges: { total: number; recent: { at: string; actor: string; summary: string }[] };
  notes: string[];
};

export type IncidentView = {
  id: number;
  title: string;
  status: IncidentStatus;
  language: IncidentLanguage;
  detectedAt: string;
  period: { from: string; to: string };
  alertEventId: number | null;
  proxyHosts: { id: number; name: string }[];
  facts: IncidentFacts | null;
  factsCollectedAt: string | null;
  stages: IncidentStageView[];
  createdAt: string;
  createdBy: { userId: number | null; name: string | null };
  updatedAt: string;
  // ── Incident register ──
  /** When the incident started and ended; null while unknown or ongoing. */
  startedAt: string | null;
  endedAt: string | null;
  classification: Classification;
  classifiedAt: string | null;
  classifiedBy: { userId: number | null; name: string | null } | null;
  assessment: IncidentAssessment;
  /** What the answers suggest (the classification is a person's decision). */
  suggestedClassification: Classification;
  cause: string | null;
  /** Entries people added and entries from the collected facts, oldest first. */
  timeline: TimelineEntry[];
  closedAt: string | null;
  notification: NotificationStatus;
};

export type IncidentSummaryView = {
  id: number;
  title: string;
  status: IncidentStatus;
  detectedAt: string;
  /** The earliest stage not submitted yet, with its deadline. */
  nextDeadline: { stage: IncidentStageKey; label: string; at: string; overdue: boolean } | null;
  submittedStages: number;
  createdAt: string;
  createdBy: { userId: number | null; name: string | null };
  startedAt: string | null;
  endedAt: string | null;
  proxyHostCount: number;
  classification: Classification;
  notification: NotificationStatus;
  closedAt: string | null;
};

export type AiDraftAvailability = { configured: boolean };
