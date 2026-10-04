// SPDX-License-Identifier: Elastic-2.0
/**
 * NIS2 incident notification drafts: one per incident, with the three
 * Article 23 stages, the facts collected for it and the deadlines that run
 * from when the organisation became aware of it.
 *
 * Nothing here sends anything anywhere: a person copies the text into the
 * CSIRT's or authority's channel (in Italy, CSIRT Italia at ACN) and records
 * the submission time and reference here.
 *
 * Licensing: creating a draft, changing it, refreshing its facts and
 * drafting a stage need "compliance_reports"; reading and deleting never do.
 */
import { count, eq, inArray } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { alertEvents, complianceIncidents, proxyHosts, users } from "@/src/lib/db/schema";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import { requireFeature } from "@/ee/licensing/store";
import { collectIncidentFacts } from "./incident-facts";
import { requestStageDraft, defaultAiDraftDependencies, type AiDraftDependencies } from "./incident-ai";
import {
  INCIDENT_STAGES,
  MAX_FIELD_CHARS,
  MAX_REFERENCE_CHARS,
  STAGE_KEYS,
  deadlineStatus,
  emptyStage,
  isStageKey,
  stageDeadline,
  stageDefinition,
} from "./incident-stages";
import { buildStageTemplate } from "./incident-template";
import {
  ASSESSMENT_KEYS,
  CLASSIFICATIONS,
  MAX_CAUSE_CHARS,
  MAX_REASON_CHARS,
  MAX_TIMELINE_ENTRIES,
  MAX_TIMELINE_TEXT,
  emptyAssessment,
  factsTimeline,
  mergeTimeline,
  suggestedClassification,
  type Classification,
  type IncidentAssessment,
  type NotificationStatus,
  type TimelineEntry,
} from "./incident-register";
import {
  AiDraftError,
  isRecord,
  parseInstant,
  parseLine,
  parseMultiline,
  rejectUnknownKeys,
  requireRecord,
} from "./http";
import { defaultAnalytics, type AnalyticsDependencies } from "./reports/shared";
import {
  CHOICE_VALUES,
  FEATURE,
  INCIDENT_LANGUAGES,
  INCIDENT_STATUSES,
  type IncidentFacts,
  type IncidentLanguage,
  type IncidentStageKey,
  type IncidentStageView,
  type IncidentStatus,
  type IncidentSummaryView,
  type IncidentView,
  type StoredIncidentStage,
} from "./types";
import { asc, desc, first } from "@/src/lib/db/ops";

export const INCIDENT_NOT_FOUND = "Incident draft not found";
export const MAX_INCIDENT_PERIOD_DAYS = 31;
export const MAX_AFFECTED_HOSTS = 50;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Clock skew allowed for times that must not be in the future. */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

type IncidentRow = typeof complianceIncidents.$inferSelect;
type Stages = Record<IncidentStageKey, StoredIncidentStage>;

export type IncidentDependencies = {
  now: () => Date;
  analytics: AnalyticsDependencies;
  ai: AiDraftDependencies;
};

function dependencies(overrides: Partial<IncidentDependencies> = {}): IncidentDependencies {
  return {
    now: overrides.now ?? (() => new Date()),
    analytics: overrides.analytics ?? defaultAnalytics,
    ai: overrides.ai ?? defaultAiDraftDependencies,
  };
}

// ── Stored values ──────────────────────────────────────────────────────

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Stages as stored; unknown stages and fields are dropped, missing ones start empty. */
export function parseStoredStages(raw: string | null | undefined): Stages {
  let value: unknown;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {
    value = null;
  }
  const stored = isRecord(value) ? value : {};
  const stages = {} as Stages;
  for (const key of STAGE_KEYS) {
    const stage = emptyStage(key);
    const entry = stored[key];
    if (isRecord(entry)) {
      const fields = isRecord(entry.fields) ? entry.fields : {};
      for (const field of stageDefinition(key).fields) {
        const text = fields[field.key];
        if (typeof text !== "string") continue;
        if (field.kind === "choice") stage.fields[field.key] = (CHOICE_VALUES as readonly string[]).includes(text) ? text : "unknown";
        else stage.fields[field.key] = text.slice(0, MAX_FIELD_CHARS);
      }
      const ai = isRecord(entry.ai) ? entry.ai : null;
      stage.ai = ai && typeof ai.provider === "string" && typeof ai.model === "string" && isoOrNull(ai.generatedAt)
        ? { generatedAt: isoOrNull(ai.generatedAt)!, provider: ai.provider, model: ai.model }
        : null;
      stage.editedAt = isoOrNull(entry.editedAt);
      stage.submittedAt = isoOrNull(entry.submittedAt);
      stage.reference = typeof entry.reference === "string" && entry.reference ? entry.reference.slice(0, MAX_REFERENCE_CHARS) : null;
    }
    stages[key] = stage;
  }
  return stages;
}

function parseStoredFacts(raw: string | null): IncidentFacts | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return isRecord(value) ? (value as IncidentFacts) : null;
  } catch {
    return null;
  }
}

function parseHostIds(raw: string): number[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((id): id is number => Number.isSafeInteger(id) && id > 0) : [];
  } catch {
    return [];
  }
}

async function hostNames(ids: number[]): Promise<{ id: number; name: string }[]> {
  if (ids.length === 0) return [];
  const rows = await appDb.select({ id: proxyHosts.id, name: proxyHosts.name }).from(proxyHosts).where(inArray(proxyHosts.id, ids));
  const names = new Map(rows.map((row) => [row.id, row.name]));
  return ids.map((id) => ({ id, name: names.get(id) ?? `Deleted host #${id}` }));
}

function stageViews(row: Pick<IncidentRow, "detectedAt" | "stages">, now: Date): IncidentStageView[] {
  const stages = parseStoredStages(row.stages);
  const detectedAt = new Date(row.detectedAt);
  const notificationSubmitted = stages.notification.submittedAt ? new Date(stages.notification.submittedAt) : null;
  return INCIDENT_STAGES.map((definition) => {
    const stage = stages[definition.key];
    const deadline = stageDeadline(definition.key, detectedAt, notificationSubmitted);
    return {
      ...stage,
      key: definition.key,
      label: definition.label,
      legalBasis: definition.legalBasis,
      deadline: deadline.toISOString(),
      deadlineRule: definition.deadlineRule,
      status: deadlineStatus(stage, deadline, now),
    };
  });
}

/** The assessment as stored; anything unreadable is "unknown". */
export function parseStoredAssessment(raw: string | null | undefined): IncidentAssessment {
  const assessment = emptyAssessment();
  let value: unknown;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {
    value = null;
  }
  if (!isRecord(value)) return assessment;
  for (const key of ASSESSMENT_KEYS) {
    const entry = value[key];
    if (!isRecord(entry)) continue;
    assessment[key] = {
      answer: (CHOICE_VALUES as readonly unknown[]).includes(entry.answer) ? (entry.answer as IncidentAssessment[typeof key]["answer"]) : "unknown",
      reason: typeof entry.reason === "string" ? entry.reason.slice(0, MAX_REASON_CHARS) : "",
    };
  }
  return assessment;
}

function parseStoredTimeline(raw: string | null | undefined): TimelineEntry[] {
  let value: unknown;
  try {
    value = raw ? JSON.parse(raw) : [];
  } catch {
    value = [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((entry) => ({ at: isoOrNull(entry.at), text: typeof entry.text === "string" ? entry.text.slice(0, MAX_TIMELINE_TEXT) : "" }))
    .filter((entry): entry is { at: string; text: string } => entry.at !== null && entry.text.length > 0)
    .map((entry) => ({ ...entry, source: "person" as const }));
}

function classification(value: string | null | undefined): Classification {
  return (CLASSIFICATIONS as readonly string[]).includes(value ?? "") ? (value as Classification) : "undetermined";
}

function notificationStatus(row: Pick<IncidentRow, "classification" | "stages">): NotificationStatus {
  const kind = classification(row.classification);
  if (kind === "not_significant") return "not_required";
  if (kind === "undetermined") return "undetermined";
  const stages = parseStoredStages(row.stages);
  return STAGE_KEYS.every((key) => stages[key].submittedAt) ? "submitted" : "required";
}

function language(value: string): IncidentLanguage {
  return (INCIDENT_LANGUAGES as readonly string[]).includes(value) ? (value as IncidentLanguage) : "en";
}

function status(value: string): IncidentStatus {
  return value === "closed" ? "closed" : "open";
}

export async function toIncidentView(row: IncidentRow, now: Date = new Date()): Promise<IncidentView> {
  return {
    id: row.id,
    title: row.title,
    status: status(row.status),
    language: language(row.language),
    detectedAt: row.detectedAt,
    period: { from: row.periodFrom, to: row.periodTo },
    alertEventId: row.alertEventId,
    proxyHosts: await hostNames(parseHostIds(row.proxyHostIds)),
    facts: parseStoredFacts(row.facts),
    factsCollectedAt: row.factsCollectedAt,
    stages: stageViews(row, now),
    createdAt: row.createdAt,
    createdBy: { userId: row.createdBy, name: row.createdByName },
    updatedAt: row.updatedAt,
    startedAt: row.startedAt ?? null,
    endedAt: row.endedAt ?? null,
    classification: classification(row.classification),
    classifiedAt: row.classifiedAt ?? null,
    classifiedBy: row.classifiedAt ? { userId: row.classifiedBy ?? null, name: row.classifiedByName ?? null } : null,
    assessment: parseStoredAssessment(row.assessment),
    suggestedClassification: suggestedClassification(parseStoredAssessment(row.assessment)),
    cause: row.cause ?? null,
    timeline: mergeTimeline(parseStoredTimeline(row.timeline), factsTimeline(parseStoredFacts(row.facts), row.detectedAt)),
    closedAt: row.closedAt ?? null,
    notification: notificationStatus(row),
  };
}

function toSummaryView(row: IncidentRow, now: Date): IncidentSummaryView {
  const stages = stageViews(row, now);
  const next = stages.find((stage) => !stage.submittedAt) ?? null;
  return {
    id: row.id,
    title: row.title,
    status: status(row.status),
    detectedAt: row.detectedAt,
    nextDeadline: next ? { stage: next.key, label: next.label, at: next.deadline, overdue: next.status === "overdue" } : null,
    submittedStages: stages.filter((stage) => stage.submittedAt).length,
    createdAt: row.createdAt,
    createdBy: { userId: row.createdBy, name: row.createdByName },
    startedAt: row.startedAt ?? null,
    endedAt: row.endedAt ?? null,
    proxyHostCount: parseHostIds(row.proxyHostIds).length,
    classification: classification(row.classification),
    notification: notificationStatus(row),
    closedAt: row.closedAt ?? null,
  };
}

async function requireRow(id: number): Promise<IncidentRow> {
  const row = await first(appDb.select().from(complianceIncidents).where(eq(complianceIncidents.id, id)).limit(1));
  if (!row) throw new ApiClientError(INCIDENT_NOT_FOUND, 404);
  return row;
}

// ── Reading ────────────────────────────────────────────────────────────

export async function listIncidents(options: { page: number; perPage: number; status?: IncidentStatus | null }, now: Date = new Date()): Promise<{
  incidents: IncidentSummaryView[];
  total: number;
  page: number;
  perPage: number;
}> {
  const where = options.status ? eq(complianceIncidents.status, options.status) : undefined;
  const rows = await appDb
    .select()
    .from(complianceIncidents)
    .where(where)
    .orderBy(desc(complianceIncidents.detectedAt), desc(complianceIncidents.id))
    .limit(options.perPage)
    .offset((options.page - 1) * options.perPage);
  const total = (await first(appDb.select({ value: count() }).from(complianceIncidents).where(where).limit(1)))?.value ?? 0;
  return { incidents: rows.map((row) => toSummaryView(row, now)), total, page: options.page, perPage: options.perPage };
}

export async function getIncident(id: number, now: Date = new Date()): Promise<IncidentView> {
  return await toIncidentView(await requireRow(id), now);
}

// ── Input ──────────────────────────────────────────────────────────────

function parseNotFuture(value: unknown, field: string, now: Date): Date {
  const date = parseInstant(value, field);
  if (date.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) throw new ApiValidationError(`${field} must not be in the future`);
  return date;
}

async function parseProxyHostIds(value: unknown): Promise<number[]> {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new ApiValidationError("proxyHostIds must be an array of proxy host ids");
  if (value.length > MAX_AFFECTED_HOSTS) throw new ApiValidationError(`proxyHostIds may list at most ${MAX_AFFECTED_HOSTS} hosts`);
  const ids = [...new Set(value.map((id) => {
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) throw new ApiValidationError("proxyHostIds must be an array of proxy host ids");
    return id;
  }))].sort((a, b) => a - b);
  if (ids.length > 0) {
    const found = new Set((await appDb.select({ id: proxyHosts.id }).from(proxyHosts).where(inArray(proxyHosts.id, ids))).map((row) => row.id));
    const missing = ids.find((id) => !found.has(id));
    if (missing !== undefined) throw new ApiValidationError(`proxyHostIds: proxy host ${missing} does not exist`);
  }
  return ids;
}

function parseLanguage(value: unknown): IncidentLanguage {
  if (!(INCIDENT_LANGUAGES as readonly unknown[]).includes(value)) throw new ApiValidationError(`language must be one of: ${INCIDENT_LANGUAGES.join(", ")}`);
  return value as IncidentLanguage;
}

function incidentPeriod(fromRaw: unknown, toRaw: unknown, detectedAt: Date, now: Date): { from: Date; to: Date } {
  let to = toRaw === undefined || toRaw === null ? now : parseInstant(toRaw, "to", true);
  if (to.getTime() > now.getTime()) to = now;
  const from = fromRaw === undefined || fromRaw === null ? new Date(Math.min(detectedAt.getTime(), to.getTime()) - DAY_MS) : parseInstant(fromRaw, "from");
  if (from.getTime() >= to.getTime()) throw new ApiValidationError("from must be before to (and before now)");
  if (to.getTime() - from.getTime() > MAX_INCIDENT_PERIOD_DAYS * DAY_MS) {
    throw new ApiValidationError(`The period may span at most ${MAX_INCIDENT_PERIOD_DAYS} days`);
  }
  return { from, to };
}

export const REGISTER_FIELDS = ["startedAt", "endedAt", "classification", "assessment", "cause", "timeline"] as const;

type RegisterChanges = Partial<Pick<typeof complianceIncidents.$inferInsert, "startedAt" | "endedAt" | "classification" | "assessment" | "cause" | "timeline">>;

function parseOptionalInstant(value: unknown, field: string, now: Date): string | null {
  if (value === null || value === "") return null;
  return parseNotFuture(value, field, now).toISOString();
}

function parseAssessmentChanges(value: unknown, current: IncidentAssessment): IncidentAssessment {
  const record = requireRecord(value, "assessment");
  rejectUnknownKeys(record, ASSESSMENT_KEYS, "assessment");
  const next: IncidentAssessment = structuredClone(current);
  for (const key of ASSESSMENT_KEYS) {
    if (record[key] === undefined) continue;
    const entry = requireRecord(record[key], `assessment.${key}`);
    rejectUnknownKeys(entry, ["answer", "reason"], `assessment.${key}`);
    if (entry.answer !== undefined) {
      if (!(CHOICE_VALUES as readonly unknown[]).includes(entry.answer)) throw new ApiValidationError(`assessment.${key}.answer must be one of: ${CHOICE_VALUES.join(", ")}`);
      next[key].answer = entry.answer as IncidentAssessment[typeof key]["answer"];
    }
    if (entry.reason !== undefined) next[key].reason = entry.reason === null ? "" : parseMultiline(entry.reason, `assessment.${key}.reason`, MAX_REASON_CHARS);
  }
  return next;
}

function parseTimeline(value: unknown, now: Date): { at: string; text: string }[] {
  if (!Array.isArray(value)) throw new ApiValidationError("timeline must be an array of {at, text}");
  if (value.length > MAX_TIMELINE_ENTRIES) throw new ApiValidationError(`timeline may have at most ${MAX_TIMELINE_ENTRIES} entries`);
  return value
    .map((raw, index) => {
      const entry = requireRecord(raw, `timeline[${index}]`);
      rejectUnknownKeys(entry, ["at", "text", "source"], `timeline[${index}]`);
      // Entries from the facts are shown, never stored: a client sending the whole timeline back keeps only its own.
      if (entry.source === "facts") return null;
      return { at: parseNotFuture(entry.at, `timeline[${index}].at`, now).toISOString(), text: parseLine(entry.text, `timeline[${index}].text`, MAX_TIMELINE_TEXT) };
    })
    .filter((entry): entry is { at: string; text: string } => entry !== null)
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** The register fields of a create or update body; the window must not end before it starts. */
function parseRegisterFields(record: Record<string, unknown>, existing: IncidentRow | null, now: Date): RegisterChanges {
  const changes: RegisterChanges = {};
  if (record.startedAt !== undefined) changes.startedAt = parseOptionalInstant(record.startedAt, "startedAt", now);
  if (record.endedAt !== undefined) changes.endedAt = parseOptionalInstant(record.endedAt, "endedAt", now);
  const startedAt = changes.startedAt !== undefined ? changes.startedAt : existing?.startedAt ?? null;
  const endedAt = changes.endedAt !== undefined ? changes.endedAt : existing?.endedAt ?? null;
  if (startedAt && endedAt && endedAt < startedAt) throw new ApiValidationError("endedAt must not be before startedAt");
  if (record.classification !== undefined) {
    if (!(CLASSIFICATIONS as readonly unknown[]).includes(record.classification)) {
      throw new ApiValidationError(`classification must be one of: ${CLASSIFICATIONS.join(", ")}`);
    }
    changes.classification = record.classification as Classification;
  }
  if (record.assessment !== undefined) {
    changes.assessment = JSON.stringify(parseAssessmentChanges(record.assessment, parseStoredAssessment(existing?.assessment)));
  }
  if (record.cause !== undefined) {
    changes.cause = record.cause === null ? null : parseMultiline(record.cause, "cause", MAX_CAUSE_CHARS) || null;
  }
  if (record.timeline !== undefined) changes.timeline = JSON.stringify(parseTimeline(record.timeline, now));
  return changes;
}

/**
 * The early warning's "suspected malicious" and "cross-border" choices follow
 * the assessment while nobody has set them on the stage.
 */
function syncEarlyWarning(stages: Stages, assessment: IncidentAssessment): boolean {
  let changed = false;
  for (const key of ["suspectedMalicious", "crossBorderImpact"] as const) {
    if (stages.early_warning.fields[key] === "unknown" && assessment[key].answer !== "unknown") {
      stages.early_warning.fields[key] = assessment[key].answer;
      changed = true;
    }
  }
  return changed;
}

async function actorName(userId: number): Promise<string | null> {
  const user = await first(appDb.select({ name: users.name, email: users.email, username: users.username }).from(users).where(eq(users.id, userId)).limit(1));
  return user ? (user.name ?? user.username ?? user.email) : null;
}

function templateStages(input: { title: string; detectedAt: string; language: IncidentLanguage; facts: IncidentFacts | null }): Stages {
  const stages = {} as Stages;
  for (const key of STAGE_KEYS) stages[key] = { ...emptyStage(key), fields: buildStageTemplate(key, { ...input, stages }) };
  return stages;
}

// ── Changes (license required) ─────────────────────────────────────────

/** Creates a draft with facts and a structured template. Needs the compliance_reports feature. */
export async function createIncident(body: unknown, actorUserId: number, overrides: Partial<IncidentDependencies> = {}): Promise<IncidentView> {
  await requireFeature(FEATURE);
  const deps = dependencies(overrides);
  const now = deps.now();
  const record = requireRecord(body);
  rejectUnknownKeys(record, ["title", "detectedAt", "from", "to", "alertEventId", "proxyHostIds", "language", ...REGISTER_FIELDS], "the incident");

  let alert: typeof alertEvents.$inferSelect | null = null;
  if (record.alertEventId !== undefined && record.alertEventId !== null) {
    if (typeof record.alertEventId !== "number" || !Number.isSafeInteger(record.alertEventId) || record.alertEventId < 1) {
      throw new ApiValidationError("alertEventId must be an alert event id");
    }
    alert = await first(appDb.select().from(alertEvents).where(eq(alertEvents.id, record.alertEventId)).limit(1)) ?? null;
    if (!alert) throw new ApiValidationError("alertEventId does not name an alert event");
  }
  const title = record.title === undefined || record.title === null
    ? alert
      ? parseLine(alert.title.replace(/\p{Cc}+/gu, " ").slice(0, 200), "title", 200)
      : parseLine(record.title, "title", 200)
    : parseLine(record.title, "title", 200);
  const detectedAt = record.detectedAt !== undefined && record.detectedAt !== null
    ? parseNotFuture(record.detectedAt, "detectedAt", now)
    : alert
      ? new Date(alert.createdAt)
      : now;
  const period = incidentPeriod(record.from, record.to, detectedAt, now);
  const proxyHostIds = record.proxyHostIds === undefined ? [] : await parseProxyHostIds(record.proxyHostIds);
  const lang = record.language === undefined ? "en" : parseLanguage(record.language);

  const facts = await collectIncidentFacts(
    { from: period.from, to: period.to, detectedAt, proxyHostIds, alertEventId: alert?.id ?? null },
    deps.analytics
  );
  const stamp = now.toISOString();
  const stages = templateStages({ title, detectedAt: detectedAt.toISOString(), language: lang, facts });
  const register = parseRegisterFields(record, null, now);
  if (register.startedAt === undefined && alert) register.startedAt = new Date(alert.createdAt).toISOString();
  const assessment = register.assessment ? parseStoredAssessment(register.assessment) : emptyAssessment();
  syncEarlyWarning(stages, assessment);
  const classified = register.classification !== undefined && register.classification !== "undetermined";
  const row = (await first(appDb
    .insert(complianceIncidents)
    .values({
      title,
      status: "open",
      language: lang,
      detectedAt: detectedAt.toISOString(),
      periodFrom: period.from.toISOString(),
      periodTo: period.to.toISOString(),
      alertEventId: alert?.id ?? null,
      proxyHostIds: JSON.stringify(proxyHostIds),
      facts: JSON.stringify(facts),
      factsCollectedAt: stamp,
      stages: JSON.stringify(stages),
      createdBy: actorUserId,
      createdByName: await actorName(actorUserId),
      createdAt: stamp,
      updatedBy: actorUserId,
      updatedAt: stamp,
      startedAt: register.startedAt ?? null,
      endedAt: register.endedAt ?? null,
      classification: register.classification ?? "undetermined",
      classifiedAt: classified ? stamp : null,
      classifiedBy: classified ? actorUserId : null,
      classifiedByName: classified ? await actorName(actorUserId) : null,
      assessment: JSON.stringify(assessment),
      cause: register.cause ?? null,
      timeline: register.timeline ?? "[]",
    })
    .returning()))!;
  await logAuditEvent({
    userId: actorUserId,
    action: "compliance_incident_created",
    entityType: "compliance_incident",
    entityId: row.id,
    summary: `Recorded the incident "${title}"`,
    data: {
      detectedAt: row.detectedAt,
      from: row.periodFrom,
      to: row.periodTo,
      alertEventId: row.alertEventId,
      proxyHostIds,
      language: lang,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      classification: row.classification,
    },
  });
  return await toIncidentView(row, now);
}

function parseStageChanges(value: unknown, current: Stages, now: Date): { stages: Stages; changed: string[] } {
  const record = requireRecord(value, "stages");
  rejectUnknownKeys(record, STAGE_KEYS, "stages");
  const stages: Stages = structuredClone(current);
  const changed: string[] = [];
  for (const [key, raw] of Object.entries(record)) {
    if (!isStageKey(key)) continue;
    const input = requireRecord(raw, `stages.${key}`);
    rejectUnknownKeys(input, ["fields", "submittedAt", "reference"], `stages.${key}`);
    const stage = stages[key];
    const definition = stageDefinition(key);
    if (input.fields !== undefined) {
      const fields = requireRecord(input.fields, `stages.${key}.fields`);
      rejectUnknownKeys(fields, definition.fields.map((field) => field.key), `stages.${key}.fields`);
      let edited = false;
      for (const field of definition.fields) {
        if (fields[field.key] === undefined) continue;
        const name = `stages.${key}.fields.${field.key}`;
        const next = field.kind === "choice"
          ? (() => {
              if (!(CHOICE_VALUES as readonly unknown[]).includes(fields[field.key])) throw new ApiValidationError(`${name} must be one of: ${CHOICE_VALUES.join(", ")}`);
              return fields[field.key] as string;
            })()
          : parseMultiline(fields[field.key], name, MAX_FIELD_CHARS);
        if (next !== stage.fields[field.key]) {
          stage.fields[field.key] = next;
          edited = true;
        }
      }
      if (edited) {
        stage.editedAt = now.toISOString();
        changed.push(`${key}.fields`);
      }
    }
    if (input.submittedAt !== undefined) {
      const submittedAt = input.submittedAt === null ? null : parseNotFuture(input.submittedAt, `stages.${key}.submittedAt`, now).toISOString();
      if (submittedAt !== stage.submittedAt) {
        stage.submittedAt = submittedAt;
        changed.push(`${key}.submittedAt`);
      }
    }
    if (input.reference !== undefined) {
      const reference = input.reference === null || input.reference === "" ? null : parseLine(input.reference, `stages.${key}.reference`, MAX_REFERENCE_CHARS);
      if (reference !== stage.reference) {
        stage.reference = reference;
        changed.push(`${key}.reference`);
      }
    }
  }
  return { stages, changed };
}

/**
 * Changes a draft. Fields left out keep their values. Needs no license: an
 * incident under way must stay editable, and its submission recordable,
 * after a license lapses.
 */
export async function updateIncident(id: number, body: unknown, actorUserId: number, overrides: Partial<IncidentDependencies> = {}): Promise<IncidentView> {
  const existing = await requireRow(id);
  const deps = dependencies(overrides);
  const now = deps.now();
  const record = requireRecord(body);
  rejectUnknownKeys(record, ["title", "status", "language", "detectedAt", "from", "to", "proxyHostIds", "stages", ...REGISTER_FIELDS], "the incident");

  const changes: Partial<typeof complianceIncidents.$inferInsert> = {};
  const changed: string[] = [];
  if (record.title !== undefined) {
    const title = parseLine(record.title, "title", 200);
    if (title !== existing.title) {
      changes.title = title;
      changed.push("title");
    }
  }
  if (record.status !== undefined) {
    if (!(INCIDENT_STATUSES as readonly unknown[]).includes(record.status)) throw new ApiValidationError(`status must be one of: ${INCIDENT_STATUSES.join(", ")}`);
    if (record.status !== existing.status) {
      changes.status = record.status as IncidentStatus;
      changes.closedAt = record.status === "closed" ? now.toISOString() : null;
      changed.push("status");
    }
  }
  if (record.language !== undefined) {
    const lang = parseLanguage(record.language);
    if (lang !== existing.language) {
      changes.language = lang;
      changed.push("language");
    }
  }
  const detectedAt = record.detectedAt !== undefined ? parseNotFuture(record.detectedAt, "detectedAt", now) : new Date(existing.detectedAt);
  if (detectedAt.toISOString() !== existing.detectedAt) {
    changes.detectedAt = detectedAt.toISOString();
    changed.push("detectedAt");
  }
  let refetch = false;
  if (record.from !== undefined || record.to !== undefined) {
    const period = incidentPeriod(record.from ?? existing.periodFrom, record.to ?? existing.periodTo, detectedAt, now);
    if (period.from.toISOString() !== existing.periodFrom || period.to.toISOString() !== existing.periodTo) {
      changes.periodFrom = period.from.toISOString();
      changes.periodTo = period.to.toISOString();
      changed.push("period");
      refetch = true;
    }
  }
  if (record.proxyHostIds !== undefined) {
    const ids = await parseProxyHostIds(record.proxyHostIds);
    if (JSON.stringify(ids) !== JSON.stringify(parseHostIds(existing.proxyHostIds))) {
      changes.proxyHostIds = JSON.stringify(ids);
      changed.push("proxyHostIds");
      refetch = true;
    }
  }
  let stagesNow = parseStoredStages(existing.stages);
  if (record.stages !== undefined) {
    const result = parseStageChanges(record.stages, stagesNow, now);
    if (result.changed.length > 0) {
      stagesNow = result.stages;
      changes.stages = JSON.stringify(result.stages);
      changed.push(...result.changed.map((item) => `stages.${item}`));
    }
  }
  const register = parseRegisterFields(record, existing, now);
  for (const key of REGISTER_FIELDS) {
    const value = register[key];
    if (value === undefined || value === (existing[key] ?? null)) continue;
    (changes as Record<string, unknown>)[key] = value;
    changed.push(key);
  }
  let classifiedNow = false;
  if (changes.classification !== undefined) {
    changes.classifiedAt = now.toISOString();
    changes.classifiedBy = actorUserId;
    changes.classifiedByName = await actorName(actorUserId);
    classifiedNow = true;
  }
  if (changes.assessment !== undefined && syncEarlyWarning(stagesNow, parseStoredAssessment(changes.assessment))) {
    changes.stages = JSON.stringify(stagesNow);
  }
  if (refetch) {
    const facts = await collectIncidentFacts(
      {
        from: new Date(changes.periodFrom ?? existing.periodFrom),
        to: new Date(changes.periodTo ?? existing.periodTo),
        detectedAt,
        proxyHostIds: parseHostIds(changes.proxyHostIds ?? existing.proxyHostIds),
        alertEventId: existing.alertEventId,
      },
      deps.analytics
    );
    changes.facts = JSON.stringify(facts);
    changes.factsCollectedAt = now.toISOString();
  }
  if (changed.length === 0) return await toIncidentView(existing, now);

  const row = (await first(appDb
    .update(complianceIncidents)
    .set({ ...changes, updatedBy: actorUserId, updatedAt: now.toISOString() })
    .where(eq(complianceIncidents.id, id))
    .returning()))!;
  await logAuditEvent({
    userId: actorUserId,
    action: "compliance_incident_updated",
    entityType: "compliance_incident",
    entityId: id,
    summary: `Updated the incident "${row.title}"`,
    data: { changed },
  });
  if (classifiedNow) {
    await logAuditEvent({
      userId: actorUserId,
      action: "compliance_incident_classified",
      entityType: "compliance_incident",
      entityId: id,
      summary: `Classified the incident "${row.title}" as ${row.classification === "significant" ? "significant" : row.classification === "not_significant" ? "not significant" : "not assessed yet"}`,
      data: { classification: row.classification, assessment: parseStoredAssessment(row.assessment) },
    });
  }
  return await toIncidentView(row, now);
}

/** Collects the facts again for the draft's period and hosts. Needs the compliance_reports feature. */
export async function refreshIncidentFacts(id: number, actorUserId: number, overrides: Partial<IncidentDependencies> = {}): Promise<IncidentView> {
  const existing = await requireRow(id);
  await requireFeature(FEATURE);
  const deps = dependencies(overrides);
  const now = deps.now();
  const facts = await collectIncidentFacts(
    {
      from: new Date(existing.periodFrom),
      to: new Date(existing.periodTo),
      detectedAt: new Date(existing.detectedAt),
      proxyHostIds: parseHostIds(existing.proxyHostIds),
      alertEventId: existing.alertEventId,
    },
    deps.analytics
  );
  const row = (await first(appDb
    .update(complianceIncidents)
    .set({ facts: JSON.stringify(facts), factsCollectedAt: now.toISOString(), updatedBy: actorUserId, updatedAt: now.toISOString() })
    .where(eq(complianceIncidents.id, id))
    .returning()))!;
  await logAuditEvent({
    userId: actorUserId,
    action: "compliance_incident_facts_refreshed",
    entityType: "compliance_incident",
    entityId: id,
    summary: `Refreshed the facts of the incident notification draft "${row.title}"`,
    data: { analytics: facts.analytics.status },
  });
  return await toIncidentView(row, now);
}

export const DRAFT_SOURCES = ["template", "ai"] as const;
export type DraftSource = (typeof DRAFT_SOURCES)[number];

/**
 * Replaces a stage's text with the structured template or a first draft from
 * the configured AI provider. Choice fields and the submission record are
 * kept. Needs the compliance_reports feature.
 */
export async function draftIncidentStage(id: number, body: unknown, actorUserId: number, overrides: Partial<IncidentDependencies> = {}): Promise<IncidentView> {
  const existing = await requireRow(id);
  await requireFeature(FEATURE);
  const deps = dependencies(overrides);
  const now = deps.now();
  const record = requireRecord(body);
  rejectUnknownKeys(record, ["stage", "source"], "the draft request");
  if (!isStageKey(record.stage)) throw new ApiValidationError(`stage must be one of: ${STAGE_KEYS.join(", ")}`);
  const stageKey = record.stage;
  const source = record.source === undefined ? "template" : record.source;
  if (!(DRAFT_SOURCES as readonly unknown[]).includes(source)) throw new ApiValidationError("source must be template or ai");

  const stages = parseStoredStages(existing.stages);
  const facts = parseStoredFacts(existing.facts);
  const lang = language(existing.language);
  const textKeys = new Set(stageDefinition(stageKey).fields.filter((field) => field.kind === "text").map((field) => field.key));
  let fields: Record<string, string>;
  let ai: StoredIncidentStage["ai"] = null;
  if (source === "template") {
    fields = buildStageTemplate(stageKey, { title: existing.title, detectedAt: existing.detectedAt, language: lang, facts, stages });
  } else {
    const result = await requestStageDraft(stageKey, { title: existing.title, detectedAt: existing.detectedAt, language: lang, facts }, deps.ai);
    await logAuditEvent({
      userId: actorUserId,
      action: "compliance_incident_drafted",
      entityType: "compliance_incident",
      entityId: id,
      summary: `Asked the AI provider to draft the ${stageDefinition(stageKey).label.toLowerCase()} of "${existing.title}": ${result.ok ? "drafted" : "failed"}`,
      data: { stage: stageKey, source, ok: result.ok, ...(result.ok ? { provider: result.provider, model: result.model } : {}) },
    });
    if (!result.ok) {
      if (result.unavailable) throw new ApiValidationError(result.error);
      throw new AiDraftError(result.error);
    }
    fields = result.fields;
    ai = { generatedAt: now.toISOString(), provider: result.provider, model: result.model };
  }
  const stage = stages[stageKey];
  for (const [key, value] of Object.entries(fields)) {
    if (textKeys.has(key)) stage.fields[key] = value;
  }
  stage.ai = ai;
  stage.editedAt = null;
  const row = (await first(appDb
    .update(complianceIncidents)
    .set({ stages: JSON.stringify(stages), updatedBy: actorUserId, updatedAt: now.toISOString() })
    .where(eq(complianceIncidents.id, id))
    .returning()))!;
  if (source === "template") {
    await logAuditEvent({
      userId: actorUserId,
      action: "compliance_incident_drafted",
      entityType: "compliance_incident",
      entityId: id,
      summary: `Filled the ${stageDefinition(stageKey).label.toLowerCase()} of "${existing.title}" from the template`,
      data: { stage: stageKey, source },
    });
  }
  return await toIncidentView(row, now);
}

/** Never needs a license. */
export async function deleteIncident(id: number, actorUserId: number): Promise<void> {
  const existing = await requireRow(id);
  await appDb.delete(complianceIncidents).where(eq(complianceIncidents.id, id));
  await logAuditEvent({
    userId: actorUserId,
    action: "compliance_incident_deleted",
    entityType: "compliance_incident",
    entityId: id,
    summary: `Deleted the incident notification draft "${existing.title}"`,
    data: { detectedAt: existing.detectedAt },
  });
}

/** Proxy hosts that can be named as affected (ids and names only). */
export async function listProxyHostChoices(): Promise<{ id: number; name: string }[]> {
  return await appDb.select({ id: proxyHosts.id, name: proxyHosts.name }).from(proxyHosts).orderBy(asc(proxyHosts.name), asc(proxyHosts.id));
}

/** Recent alert events and proxy hosts to start a draft from (ids, names and titles only). */
export async function listDraftSources(limit = 50): Promise<{
  alertEvents: { id: number; at: string; severity: string; status: string; title: string }[];
  proxyHosts: { id: number; name: string }[];
}> {
  return {
    alertEvents: await appDb
      .select({ id: alertEvents.id, at: alertEvents.createdAt, severity: alertEvents.severity, status: alertEvents.status, title: alertEvents.title })
      .from(alertEvents)
      .orderBy(desc(alertEvents.createdAt), desc(alertEvents.id))
      .limit(limit),
    proxyHosts: await listProxyHostChoices(),
  };
}

