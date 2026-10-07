// SPDX-License-Identifier: Elastic-2.0
/**
 * Dismissing alerts and muting rules (alert_silences).
 *
 * - A dismissal covers one alert (a rule and a subject). Without `until` it
 *   lasts until that subject resolves. With `until` it lasts until then, and
 *   also covers the subject when it resolves and fires again before then.
 * - A mute covers every subject of a rule until `until`.
 * - A subject that starts firing while covered is recorded in the history as
 *   not notified (`silenced`), and nothing is sent; since its firing
 *   notification was not sent, no resolve notice follows either. Covered
 *   alerts are left out of "Needs attention" and the sidebar badge, and stay
 *   on the Firing tab, marked. What was already sent is not taken back: an
 *   alert dismissed after its firing notification went out still gets its
 *   resolve notice.
 * - A new dismissal of the same alert, or a new mute of the same rule,
 *   replaces the previous one.
 * - Each evaluation run (engine.ts) prunes the ones that ended: expired, or
 *   dismissed until a subject resolves that no longer fires (the engine also
 *   removes those when it records the resolve). Deleting a rule deletes its
 *   rows (foreign keys are not enforced).
 */
import { and, eq, gt, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { appDb, toIso } from "@/src/lib/db";
import { desc } from "@/src/lib/db/ops";
import { isRowId } from "@/src/lib/row-ids";
import { alertRules, alertRuleStates, alertSilences, users } from "@/src/lib/db/schema";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiClientError, ApiConflictError, ApiValidationError } from "@/src/lib/api-errors";
import { MAX_SILENCE_MINUTES, MAX_SILENCE_NOTE_LENGTH, isRuleType, type AlertSilenceView } from "./types";
import { rejectUnknownKeys, requireObject } from "./validation";

type SilenceRow = typeof alertSilences.$inferSelect;

const SILENCE_FIELDS = ["ruleId", "subjectKey", "until", "durationMinutes", "note"];
const MAX_SUBJECT_KEY_LENGTH = 500;
/** Whether `text` has control characters other than tabs and line breaks. */
function hasControlCharacters(text: string): boolean {
  return /\p{Cc}/u.test(text.replace(/[\t\n\r]/g, ""));
}

/** The key of a rule's subject in the maps below. */
export function subjectId(ruleId: number, subjectKey: string): string {
  return `${ruleId}\u0000${subjectKey}`;
}

/** Whether a row is in effect at `now` (ISO). A dismissal without `until` is, until it is removed. */
function inEffect(row: Pick<SilenceRow, "subjectKey" | "until">, now: string): boolean {
  if (row.until === null) return row.subjectKey !== null;
  return row.until > now;
}

/** The SQL form of inEffect. */
function inEffectCondition(now: string) {
  return or(and(isNull(alertSilences.until), isNotNull(alertSilences.subjectKey)), gt(alertSilences.until, now));
}

export type ActiveSilences = {
  /** Mutes by rule id. */
  mutes: Map<number, SilenceRow>;
  /** Dismissals by subjectId(ruleId, subjectKey). */
  dismissals: Map<string, SilenceRow>;
};

function indexRows(rows: readonly SilenceRow[], now: string): ActiveSilences {
  const mutes = new Map<number, SilenceRow>();
  const dismissals = new Map<string, SilenceRow>();
  // Oldest first, so the newest row of a rule or subject wins.
  for (const row of [...rows].sort((a, b) => a.id - b.id)) {
    if (!inEffect(row, now)) continue;
    if (row.subjectKey === null) mutes.set(row.ruleId, row);
    else dismissals.set(subjectId(row.ruleId, row.subjectKey), row);
  }
  return { mutes, dismissals };
}

/** The mutes and dismissals in effect at `now`, for the engine. */
export async function loadActiveSilences(now: Date = new Date()): Promise<ActiveSilences> {
  const at = now.toISOString();
  return indexRows(await appDb.select().from(alertSilences).where(inEffectCondition(at)), at);
}

/**
 * How a subject that starts firing at `now` is covered: "muted" (its rule is
 * muted), "dismissed" (dismissed until a time still ahead) or null. A
 * dismissal until the subject resolves belongs to an episode that ended, so
 * it never covers a new one.
 */
export function coverOnFiring(silences: ActiveSilences, ruleId: number, subjectKey: string): "muted" | "dismissed" | null {
  const dismissal = silences.dismissals.get(subjectId(ruleId, subjectKey));
  if (dismissal?.until) return "dismissed";
  if (silences.mutes.has(ruleId)) return "muted";
  return null;
}

/** Ends the dismissals of a subject that last until it resolves (it just did, or a new episode starts). */
export async function endDismissalsUntilResolved(ruleId: number, subjectKey: string): Promise<void> {
  await appDb
    .delete(alertSilences)
    .where(and(eq(alertSilences.ruleId, ruleId), eq(alertSilences.subjectKey, subjectKey), isNull(alertSilences.until)));
}

/**
 * Removes what ended by `now`: expired rows, and dismissals until a subject
 * resolves whose subject no longer fires (its rule was disabled, or it
 * resolved while the row was being created).
 */
export async function pruneAlertSilences(now: Date = new Date()): Promise<void> {
  await appDb.delete(alertSilences).where(lte(alertSilences.until, now.toISOString()));
  const untilResolved = await appDb
    .select({ id: alertSilences.id, ruleId: alertSilences.ruleId, subjectKey: alertSilences.subjectKey })
    .from(alertSilences)
    .where(isNull(alertSilences.until));
  if (untilResolved.length === 0) return;
  const firing = new Set(
    (await appDb
      .select({ ruleId: alertRuleStates.ruleId, subjectKey: alertRuleStates.subjectKey })
      .from(alertRuleStates)
      .where(eq(alertRuleStates.status, "firing"))).map((row) => subjectId(row.ruleId, row.subjectKey))
  );
  const ended = untilResolved.filter((row) => row.subjectKey === null || !firing.has(subjectId(row.ruleId, row.subjectKey))).map((row) => row.id);
  if (ended.length > 0) await appDb.delete(alertSilences).where(inArray(alertSilences.id, ended));
}

/** Every row of a rule (the rule is being deleted). */
export async function deleteRuleSilences(ruleId: number): Promise<void> {
  await appDb.delete(alertSilences).where(eq(alertSilences.ruleId, ruleId));
}

/** The rule's dismissals that last until their subject resolves (the rule stops watching). */
export async function deleteRuleDismissalsUntilResolved(ruleId: number): Promise<void> {
  await appDb.delete(alertSilences).where(and(eq(alertSilences.ruleId, ruleId), isNull(alertSilences.until)));
}

// ── Views ──

type ViewRow = {
  silence: SilenceRow;
  ruleName: string | null;
  userName: string | null;
  userEmail: string | null;
};

function toView(row: ViewRow, titles: ReadonlyMap<string, string | null>): AlertSilenceView {
  const { silence } = row;
  return {
    id: silence.id,
    kind: silence.subjectKey === null ? "mute" : "dismissal",
    ruleId: silence.ruleId,
    ruleName: row.ruleName ?? `Rule #${silence.ruleId}`,
    subjectKey: silence.subjectKey,
    subjectTitle: silence.subjectKey === null ? null : titles.get(subjectId(silence.ruleId, silence.subjectKey)) ?? null,
    until: silence.until ? toIso(silence.until) : null,
    note: silence.note,
    createdBy: silence.createdBy,
    createdByName: row.userName || row.userEmail || null,
    createdAt: toIso(silence.createdAt)!,
  };
}

async function viewRows(where: ReturnType<typeof and>): Promise<AlertSilenceView[]> {
  const rows = await appDb
    .select({ silence: alertSilences, ruleName: alertRules.name, userName: users.name, userEmail: users.email })
    .from(alertSilences)
    .leftJoin(alertRules, eq(alertRules.id, alertSilences.ruleId))
    .leftJoin(users, eq(users.id, alertSilences.createdBy))
    .where(where)
    .orderBy(desc(alertSilences.createdAt), desc(alertSilences.id));
  const ruleIds = [...new Set(rows.filter((row) => row.silence.subjectKey !== null).map((row) => row.silence.ruleId))];
  const titles = new Map<string, string | null>();
  if (ruleIds.length > 0) {
    const states = await appDb
      .select({ ruleId: alertRuleStates.ruleId, subjectKey: alertRuleStates.subjectKey, title: alertRuleStates.title })
      .from(alertRuleStates)
      .where(and(inArray(alertRuleStates.ruleId, ruleIds), eq(alertRuleStates.status, "firing")));
    for (const state of states) titles.set(subjectId(state.ruleId, state.subjectKey), state.title);
  }
  return rows.map((row) => toView(row, titles));
}

/** The mutes and dismissals in effect, newest first. */
export async function listAlertSilences(now: Date = new Date()): Promise<AlertSilenceView[]> {
  const at = now.toISOString();
  const views = await viewRows(inEffectCondition(at));
  // A newer row replaced an older one of the same rule or subject (see createAlertSilence).
  const seen = new Set<string>();
  return views.filter((view) => {
    const key = view.subjectKey === null ? `mute:${view.ruleId}` : subjectId(view.ruleId, view.subjectKey);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** listAlertSilences, indexed like ActiveSilences. */
export async function silenceViewsByTarget(now: Date = new Date()): Promise<{ mutes: Map<number, AlertSilenceView>; dismissals: Map<string, AlertSilenceView> }> {
  const mutes = new Map<number, AlertSilenceView>();
  const dismissals = new Map<string, AlertSilenceView>();
  for (const view of await listAlertSilences(now)) {
    if (view.subjectKey === null) mutes.set(view.ruleId, view);
    else dismissals.set(subjectId(view.ruleId, view.subjectKey), view);
  }
  return { mutes, dismissals };
}

// ── Changes ──

function readRuleId(value: unknown): number {
  if (!isRowId(value)) throw new ApiValidationError("ruleId must be an alert rule id");
  return value;
}

function readSubjectKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0) throw new ApiValidationError("subjectKey must be a non-empty string");
  if (value.length > MAX_SUBJECT_KEY_LENGTH) throw new ApiValidationError(`subjectKey must be at most ${MAX_SUBJECT_KEY_LENGTH} characters`);
  if (/\p{Cc}/u.test(value)) throw new ApiValidationError("subjectKey must not contain control characters");
  return value;
}

function readNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ApiValidationError("note must be a string");
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_SILENCE_NOTE_LENGTH) throw new ApiValidationError(`note must be at most ${MAX_SILENCE_NOTE_LENGTH} characters`);
  if (hasControlCharacters(trimmed)) throw new ApiValidationError("note must not contain control characters");
  return trimmed;
}

/** When it ends, from `until` or `durationMinutes`; null when neither is given (until the alert resolves). */
function readEnd(record: Record<string, unknown>, now: Date): string | null {
  const hasUntil = record.until !== undefined && record.until !== null;
  const hasDuration = record.durationMinutes !== undefined && record.durationMinutes !== null;
  if (hasUntil && hasDuration) throw new ApiValidationError("Give until or durationMinutes, not both");
  const latest = now.getTime() + MAX_SILENCE_MINUTES * 60_000;
  if (hasDuration) {
    const minutes = record.durationMinutes;
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_SILENCE_MINUTES) {
      throw new ApiValidationError(`durationMinutes must be a whole number from 1 to ${MAX_SILENCE_MINUTES}`);
    }
    return new Date(now.getTime() + minutes * 60_000).toISOString();
  }
  if (hasUntil) {
    const at = typeof record.until === "string" && /^\d{4}-\d{2}-\d{2}T/.test(record.until) ? Date.parse(record.until) : NaN;
    if (!Number.isFinite(at)) throw new ApiValidationError("until must be an ISO 8601 date and time");
    if (at <= now.getTime()) throw new ApiValidationError("until must be in the future");
    if (at > latest) throw new ApiValidationError("until must be at most 30 days ahead");
    return new Date(at).toISOString();
  }
  return null;
}

function notFound(): ApiClientError {
  return new ApiClientError("Alert mute or dismissal not found", 404);
}

/** How a row reads in the audit log. */
function describeSilence(row: Pick<SilenceRow, "subjectKey" | "until">, ruleName: string, title: string | null): string {
  if (row.subjectKey === null) return `alert rule "${ruleName}" until ${row.until}`;
  const what = `alert "${title ?? row.subjectKey}" of rule "${ruleName}"`;
  return row.until ? `${what} until ${row.until}` : `${what} until it resolves`;
}

/**
 * Dismisses an alert or mutes a rule. Body: ruleId, subjectKey (omitted: the
 * whole rule), until or durationMinutes (omitted: until the alert resolves;
 * a mute needs one), note.
 */
export async function createAlertSilence(body: unknown, actorUserId: number, now: Date = new Date()): Promise<AlertSilenceView> {
  const record = requireObject(body, "Request body");
  rejectUnknownKeys(record, SILENCE_FIELDS, "the request");
  const ruleId = readRuleId(record.ruleId);
  const [rule] = await appDb.select().from(alertRules).where(eq(alertRules.id, ruleId));
  // A rule of a type that no longer exists is treated like a missing one.
  if (!rule || !isRuleType(rule.type)) throw new ApiValidationError(`Alert rule ${ruleId} does not exist`);

  const subjectKey = readSubjectKey(record.subjectKey);
  const until = readEnd(record, now);
  const note = readNote(record.note);
  if (subjectKey === null && until === null) throw new ApiValidationError("Muting a rule needs until or durationMinutes");

  const created = await appDb.transaction(async (tx) => {
    let title: string | null = null;
    if (subjectKey !== null) {
      const [state] = await tx
        .select({ status: alertRuleStates.status, title: alertRuleStates.title })
        .from(alertRuleStates)
        .where(and(eq(alertRuleStates.ruleId, ruleId), eq(alertRuleStates.subjectKey, subjectKey)));
      const firing = state?.status === "firing" && rule.enabled;
      if (until === null && !firing) throw new ApiConflictError("The alert is not firing; dismiss it for a time instead");
      title = firing ? state.title : null;
    }
    // A new dismissal of the alert, or a new mute of the rule, replaces the previous one.
    const replaced = await tx
      .delete(alertSilences)
      .where(and(eq(alertSilences.ruleId, ruleId), subjectKey === null ? isNull(alertSilences.subjectKey) : eq(alertSilences.subjectKey, subjectKey)))
      .returning({ id: alertSilences.id });
    const [row] = await tx
      .insert(alertSilences)
      .values({ ruleId, subjectKey, until, note, createdBy: actorUserId, createdAt: now.toISOString() })
      .returning();
    return { row, title, replaced: replaced.map((item) => item.id) };
  });

  await logAuditEvent({
    userId: actorUserId,
    action: "alert_silence_created",
    entityType: "alert_silence",
    entityId: created.row.id,
    summary: `${subjectKey === null ? "Muted" : "Dismissed"} ${describeSilence(created.row, rule.name, created.title)}`,
    data: { ruleId, ruleName: rule.name, subjectKey, until, note, replaced: created.replaced },
  });
  const [view] = await viewRows(eq(alertSilences.id, created.row.id));
  return view;
}

/** Ends a dismissal or mute. */
export async function deleteAlertSilence(id: number, actorUserId: number): Promise<void> {
  const [row] = await appDb
    .select({ silence: alertSilences, ruleName: alertRules.name, title: alertRuleStates.title })
    .from(alertSilences)
    .leftJoin(alertRules, eq(alertRules.id, alertSilences.ruleId))
    .leftJoin(alertRuleStates, and(eq(alertRuleStates.ruleId, alertSilences.ruleId), eq(alertRuleStates.subjectKey, alertSilences.subjectKey)))
    .where(eq(alertSilences.id, id));
  if (!row) throw notFound();
  await appDb.delete(alertSilences).where(eq(alertSilences.id, id));
  const { silence } = row;
  const ruleName = row.ruleName ?? `#${silence.ruleId}`;
  await logAuditEvent({
    userId: actorUserId,
    action: "alert_silence_deleted",
    entityType: "alert_silence",
    entityId: id,
    summary:
      silence.subjectKey === null
        ? `Unmuted alert rule "${ruleName}"`
        : `Removed the dismissal of alert "${row.title ?? silence.subjectKey}" of rule "${ruleName}"`,
    data: { ruleId: silence.ruleId, ruleName, subjectKey: silence.subjectKey, until: silence.until, note: silence.note },
  });
}
