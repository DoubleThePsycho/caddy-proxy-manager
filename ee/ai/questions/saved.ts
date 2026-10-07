// SPDX-License-Identifier: Elastic-2.0
/**
 * Saved analytics questions: the question as typed and its validated query,
 * re-run with fresh data without asking the model again. A question belongs
 * to the user who saved it; shared, it is listed for every user who can
 * read analytics, as saved views are. Only the owner changes a question; the owner, or an
 * administrator for a shared one, deletes it. A question outside what the
 * caller can see answers 404 like a missing one.
 */
import { and, count, eq, inArray, or } from "drizzle-orm";
import { appDb, nowIso, toIso } from "@/src/lib/db";
import { analyticsQuestions, users } from "@/src/lib/db/schema";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import type { Access } from "@/src/lib/permissions";
import { describeQuery, describeRange } from "./describe";
import { parseQuestionQuery, parseQuestionText } from "./schema";
import type { QuestionQuery, SavedQuestionView } from "./types";
import { asc, first } from "@/src/lib/db/ops";

export const MAX_SAVED_QUESTIONS_PER_USER = 100;
export const SAVED_QUESTION_NOT_FOUND = "Saved question not found";

type Row = typeof analyticsQuestions.$inferSelect;

/** The stored query, validated again; null when it no longer passes (a future change of the rules). */
export function storedQuery(raw: string): QuestionQuery | null {
  try {
    return parseQuestionQuery(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** A saved query in words, with its own relative range ("the last 7 days"). */
export function describeSavedQuery(query: QuestionQuery): string {
  return describeQuery(query, describeRange(query.range));
}

function toView(row: Row, query: QuestionQuery, viewerId: number, ownerName: string | null): SavedQuestionView {
  return {
    id: row.id,
    question: row.question,
    query,
    interpretation: describeSavedQuery(query),
    shared: Boolean(row.shared),
    owned: row.userId === viewerId,
    ownerName,
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
  };
}

/** Questions a user sees: their own, and the shared ones. */
function visibleCondition(userId: number) {
  return or(eq(analyticsQuestions.userId, userId), eq(analyticsQuestions.shared, true));
}

async function ownerNames(rows: Row[]): Promise<Map<number, string | null>> {
  const ids = [...new Set(rows.map((row) => row.userId))];
  if (ids.length === 0) return new Map();
  const found = await appDb.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids));
  return new Map(found.map((user) => [user.id, user.name ?? null]));
}

async function views(rows: Row[], viewerId: number): Promise<SavedQuestionView[]> {
  const names = await ownerNames(rows);
  const out: SavedQuestionView[] = [];
  for (const row of rows) {
    const query = storedQuery(row.query);
    if (query) out.push(toView(row, query, viewerId, names.get(row.userId) ?? null));
  }
  return out;
}

export async function listSavedQuestions(access: Access): Promise<SavedQuestionView[]> {
  const rows = await appDb
    .select()
    .from(analyticsQuestions)
    .where(visibleCondition(access.userId))
    .orderBy(asc(analyticsQuestions.question), asc(analyticsQuestions.id));
  return await views(rows, access.userId);
}

async function findVisibleRow(access: Access, id: number): Promise<Row> {
  const row = Number.isSafeInteger(id) && id > 0
    ? await first(appDb.select().from(analyticsQuestions).where(and(eq(analyticsQuestions.id, id), visibleCondition(access.userId))).limit(1))
    : undefined;
  if (!row) throw new ApiClientError(SAVED_QUESTION_NOT_FOUND, 404);
  return row;
}

/** The saved question and its validated query (404 when not visible, 409 when its query no longer passes). */
export async function getSavedQuestionRow(access: Access, id: number): Promise<{ row: Row; query: QuestionQuery }> {
  const row = await findVisibleRow(access, id);
  const query = storedQuery(row.query);
  if (!query) throw new ApiClientError("This saved question can no longer be run; delete it and ask again", 409);
  return { row, query };
}

export async function getSavedQuestion(access: Access, id: number): Promise<SavedQuestionView> {
  const { row, query } = await getSavedQuestionRow(access, id);
  return toView(row, query, access.userId, (await ownerNames([row])).get(row.userId) ?? null);
}

function parseShared(value: unknown): boolean {
  if (typeof value !== "boolean") throw new ApiValidationError("shared must be true or false");
  return value;
}

function requireRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiValidationError("Request body must be a JSON object");
  return body as Record<string, unknown>;
}

function rejectUnknown(record: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new ApiValidationError(`Unknown field "${key.slice(0, 40)}" in the saved question`);
  }
}

/** Saves a question with its query (validated again). */
export async function createSavedQuestion(access: Access, body: unknown): Promise<SavedQuestionView> {
  const record = requireRecord(body);
  rejectUnknown(record, ["question", "query", "shared"]);
  const question = parseQuestionText(record.question);
  const query = parseQuestionQuery(record.query);
  const shared = record.shared === undefined ? false : parseShared(record.shared);
  const now = nowIso();
  // The limit and the insert in one transaction: it holds under concurrent requests.
  const row = await appDb.transaction(async (tx) => {
    const owned = await first(tx.select({ value: count() }).from(analyticsQuestions).where(eq(analyticsQuestions.userId, access.userId)).limit(1));
    if ((owned?.value ?? 0) >= MAX_SAVED_QUESTIONS_PER_USER) {
      throw new ApiClientError(`You can save at most ${MAX_SAVED_QUESTIONS_PER_USER} questions`, 409);
    }
    return (await first(tx
      .insert(analyticsQuestions)
      .values({ userId: access.userId, question, query: JSON.stringify(query), shared, createdAt: now, updatedAt: now })
      .returning()))!;
  });
  await logAuditEvent({
    userId: access.userId,
    action: "create",
    entityType: "analytics_question",
    entityId: row.id,
    summary: `Saved the analytics question "${question.slice(0, 120)}"${shared ? " (shared)" : ""}`,
    data: { question, query, shared },
  });
  return getSavedQuestion(access, row.id);
}

/** The owner changes the text, the query or sharing. */
export async function updateSavedQuestion(access: Access, id: number, body: unknown): Promise<SavedQuestionView> {
  const record = requireRecord(body);
  rejectUnknown(record, ["question", "query", "shared"]);
  const row = await findVisibleRow(access, id);
  if (row.userId !== access.userId) throw new ApiClientError("Only the user who saved this question can change it", 403);
  const set: Partial<typeof analyticsQuestions.$inferInsert> = {};
  if (record.question !== undefined) set.question = parseQuestionText(record.question);
  if (record.query !== undefined) set.query = JSON.stringify(parseQuestionQuery(record.query));
  if (record.shared !== undefined) set.shared = parseShared(record.shared);
  if (Object.keys(set).length === 0) throw new ApiValidationError("Nothing to change");
  set.updatedAt = nowIso();
  await appDb.update(analyticsQuestions).set(set).where(eq(analyticsQuestions.id, row.id));
  await logAuditEvent({
    userId: access.userId,
    action: "update",
    entityType: "analytics_question",
    entityId: row.id,
    summary: `Updated the analytics question "${(set.question ?? row.question).slice(0, 120)}"`,
    data: { changed: Object.keys(set).filter((key) => key !== "updatedAt"), ...(set.query ? { query: JSON.parse(set.query) } : {}) },
  });
  return getSavedQuestion(access, row.id);
}

/** The owner, or an administrator for a shared question. Report schedules keep their copies. */
export async function deleteSavedQuestion(access: Access, id: number): Promise<void> {
  const row = await findVisibleRow(access, id);
  const mayDelete = row.userId === access.userId || (access.isAdmin && row.shared);
  if (!mayDelete) throw new ApiClientError("Only the user who saved this question can delete it", 403);
  await appDb.delete(analyticsQuestions).where(eq(analyticsQuestions.id, row.id));
  await logAuditEvent({
    userId: access.userId,
    action: "delete",
    entityType: "analytics_question",
    entityId: row.id,
    summary: `Deleted the analytics question "${row.question.slice(0, 120)}"`,
  });
}

// ── For report schedules (ee/compliance) ──────────────────────────────

export type ScheduleQuestionSource = { id: number; question: string; query: QuestionQuery };

/**
 * The saved questions a user can see, by id, for copying into a report
 * schedule: their own and the shared ones. Ids they cannot see (or whose
 * query no longer passes) are left out.
 */
export async function savedQuestionsVisibleTo(userId: number, ids: readonly number[]): Promise<Map<number, ScheduleQuestionSource>> {
  if (ids.length === 0) return new Map();
  const rows = await appDb
    .select()
    .from(analyticsQuestions)
    .where(and(inArray(analyticsQuestions.id, [...ids]), visibleCondition(userId)));
  const out = new Map<number, ScheduleQuestionSource>();
  for (const row of rows) {
    const query = storedQuery(row.query);
    if (query) out.set(row.id, { id: row.id, question: row.question, query });
  }
  return out;
}
