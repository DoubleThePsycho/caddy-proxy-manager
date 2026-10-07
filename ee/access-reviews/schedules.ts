// SPDX-License-Identifier: Elastic-2.0
/**
 * Recurring access reviews: a schedule starts a campaign every
 * `intervalMonths`, due `durationDays` after it starts, with the schedule's
 * scope and reviewers.
 */
import { and, eq } from "drizzle-orm";
import { appDb, nowIso, toIso } from "@/src/lib/db";
import { accessReviewSchedules } from "@/src/lib/db/schema";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import { assertReviewable, auditCampaignStarted, insertCampaign } from "./campaigns";
import {
  describeReviewers,
  parseStoredIds,
  parseStoredScope,
  readInteger,
  readName,
  readReviewerIds,
  readScope,
  rejectUnknownKeys,
  requireRecord,
} from "./scope";
import type { ReviewScope, ScheduleView } from "./types";
import { asc, first } from "@/src/lib/db/ops";

type ScheduleRow = typeof accessReviewSchedules.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_SCHEDULES = 50;
const MAX_INTERVAL_MONTHS = 36;
const MAX_DURATION_DAYS = 365;

/** `date` plus `months` calendar months, on the same day or the month's last day. */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

async function toView(row: ScheduleRow): Promise<ScheduleView> {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    scope: parseStoredScope(row.scope),
    reviewers: await describeReviewers(appDb, parseStoredIds(row.reviewerIds)),
    durationDays: row.durationDays,
    intervalMonths: row.intervalMonths,
    nextRunAt: toIso(row.nextRunAt)!,
    lastRunAt: row.lastRunAt ? toIso(row.lastRunAt) : null,
    lastCampaignId: row.lastCampaignId,
    lastError: row.lastError,
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
  };
}

export async function listSchedules(): Promise<ScheduleView[]> {
  const rows = await appDb.select().from(accessReviewSchedules).orderBy(asc(accessReviewSchedules.id));
  return Promise.all(rows.map((row) => toView(row)));
}

export async function getSchedule(id: number): Promise<ScheduleView> {
  const row = await first(appDb.select().from(accessReviewSchedules).where(eq(accessReviewSchedules.id, id)).limit(1));
  if (!row) throw new ApiClientError("Access review schedule not found", 404);
  return await toView(row);
}

type ScheduleFields = {
  name: string;
  enabled: boolean;
  scope: ReviewScope;
  reviewerIds: number[];
  durationDays: number;
  intervalMonths: number;
};

const KEYS = ["name", "enabled", "scope", "reviewerIds", "durationDays", "intervalMonths", "firstRunAt"];

async function readFields(input: unknown, current: ScheduleFields | null): Promise<{ fields: ScheduleFields; firstRunAt: Date | null }> {
  const body = requireRecord(input);
  rejectUnknownKeys(body, current ? KEYS.filter((key) => key !== "firstRunAt") : KEYS);
  const fields: ScheduleFields = current
    ? { ...current }
    : { name: "", enabled: true, scope: { type: "all" }, reviewerIds: [], durationDays: 14, intervalMonths: 3 };
  if (body.name !== undefined || !current) fields.name = readName(body.name);
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw new ApiValidationError("enabled must be true or false");
    fields.enabled = body.enabled;
  }
  if (body.scope !== undefined || !current) fields.scope = await readScope(body.scope, appDb);
  if (body.reviewerIds !== undefined || !current) fields.reviewerIds = await readReviewerIds(body.reviewerIds, appDb);
  if (body.durationDays !== undefined) fields.durationDays = readInteger(body.durationDays, "durationDays", 1, MAX_DURATION_DAYS);
  if (body.intervalMonths !== undefined) {
    fields.intervalMonths = readInteger(body.intervalMonths, "intervalMonths", 1, MAX_INTERVAL_MONTHS);
  }
  if (fields.durationDays > fields.intervalMonths * 28) {
    throw new ApiValidationError("durationDays must be shorter than the interval between reviews");
  }
  if (fields.enabled) await assertReviewable(appDb, fields.scope, fields.reviewerIds);
  let firstRunAt: Date | null = null;
  if (body.firstRunAt !== undefined && body.firstRunAt !== null) {
    if (typeof body.firstRunAt !== "string" || Number.isNaN(new Date(body.firstRunAt).getTime())) {
      throw new ApiValidationError("firstRunAt must be an ISO 8601 date");
    }
    firstRunAt = new Date(body.firstRunAt);
  }
  return { fields, firstRunAt };
}

function columns(fields: ScheduleFields) {
  return {
    name: fields.name,
    enabled: fields.enabled,
    scope: JSON.stringify(fields.scope),
    reviewerIds: JSON.stringify(fields.reviewerIds),
    durationDays: fields.durationDays,
    intervalMonths: fields.intervalMonths,
  };
}

/**
 * Starts the campaign of `due` now and moves nextRunAt past `now`. A run
 * that cannot start (nobody in scope, the only reviewer in scope) records
 * the reason as lastError and waits for the next interval. Null when the
 * schedule was changed, disabled, deleted or run since it was read as due:
 * it is left alone.
 */
async function runSchedule(due: ScheduleRow, now: Date): Promise<{ campaignId: number | null; error: string | null } | null> {
  const nextRunAfter = (row: ScheduleRow): Date => {
    let next = new Date(row.nextRunAt);
    if (Number.isNaN(next.getTime())) next = now;
    while (next.getTime() <= now.getTime()) next = addMonths(next, row.intervalMonths);
    return next;
  };
  try {
    // Read the schedule again, start its campaign and move it on in one
    // transaction: a schedule is never run twice, nor with settings changed meanwhile.
    const created = await appDb.transaction(async (tx) => {
      const row = await first(tx.select().from(accessReviewSchedules).where(eq(accessReviewSchedules.id, due.id)).limit(1));
      if (!row || !row.enabled || row.nextRunAt !== due.nextRunAt) return null;
      const next = nextRunAfter(row);
      const dueAt = new Date(now.getTime() + row.durationDays * DAY_MS).toISOString();
      const name = `${row.name} (${now.toISOString().slice(0, 10)})`;
      const reviewerIds = parseStoredIds(row.reviewerIds);
      const result = await insertCampaign(
        tx,
        { name, scope: parseStoredScope(row.scope), reviewerIds, dueAt },
        { createdBy: row.createdBy, scheduleId: row.id }
      );
      await tx.update(accessReviewSchedules)
        .set({ nextRunAt: next.toISOString(), lastRunAt: now.toISOString(), lastCampaignId: result.id, lastError: null, updatedAt: nowIso() })
        .where(eq(accessReviewSchedules.id, row.id));
      return { ...result, name, dueAt };
    }, { behavior: "immediate" });
    if (!created) return null;
    await auditCampaignStarted(null, { ...created, scheduleId: due.id });
    return { campaignId: created.id, error: null };
  } catch (error) {
    const message = error instanceof ApiClientError ? error.message : "The review could not be started";
    if (!(error instanceof ApiClientError)) {
      console.error("[access-reviews] Scheduled review failed:", error instanceof Error ? error.name : typeof error);
    }
    await appDb.update(accessReviewSchedules)
      .set({ nextRunAt: nextRunAfter(due).toISOString(), lastRunAt: now.toISOString(), lastError: message, updatedAt: nowIso() })
      .where(and(eq(accessReviewSchedules.id, due.id), eq(accessReviewSchedules.nextRunAt, due.nextRunAt)));
    return { campaignId: null, error: message };
  }
}

/** Starts the campaigns of every enabled schedule that is due. */
export async function runDueSchedules(now: Date = new Date()): Promise<{ started: number; failed: number }> {
  const due = (await appDb
    .select()
    .from(accessReviewSchedules)
    .where(eq(accessReviewSchedules.enabled, true))
    .orderBy(asc(accessReviewSchedules.id)))
    .filter((row) => new Date(row.nextRunAt).getTime() <= now.getTime());
  let started = 0;
  let failed = 0;
  for (const row of due) {
    const result = await runSchedule(row, now);
    if (result === null) continue;
    if (result.campaignId !== null) started++;
    else failed++;
  }
  return { started, failed };
}

/** Creates a schedule; when firstRunAt is now or earlier (the default), the first campaign starts right away. */
export async function createSchedule(input: unknown, actorUserId: number): Promise<ScheduleView> {
  const { fields, firstRunAt } = await readFields(input, null);
  const now = new Date();
  const start = firstRunAt ?? now;
  // The limit and the insert in one transaction: it holds under concurrent requests.
  const row = await appDb.transaction(async (tx) => {
    const existing = await tx.select({ id: accessReviewSchedules.id }).from(accessReviewSchedules);
    if (existing.length >= MAX_SCHEDULES) throw new ApiValidationError(`At most ${MAX_SCHEDULES} access review schedules`);
    return (await first(tx
      .insert(accessReviewSchedules)
      .values({ ...columns(fields), nextRunAt: start.toISOString(), createdBy: actorUserId, createdAt: nowIso(), updatedAt: nowIso() })
      .returning()))!;
  });
  await logAuditEvent({
    userId: actorUserId,
    action: "create",
    entityType: "access_review_schedule",
    entityId: row.id,
    summary: `Created access review schedule "${fields.name}": every ${fields.intervalMonths} month(s), ${fields.durationDays} day(s) to review`,
    data: { ...fields, firstRunAt: start.toISOString() },
  });
  // A run that cannot start keeps the schedule; the reason is shown as its last error.
  if (fields.enabled && start.getTime() <= now.getTime()) await runSchedule(row, now);
  return await getSchedule(row.id);
}

export async function updateSchedule(id: number, input: unknown, actorUserId: number): Promise<ScheduleView> {
  const row = await first(appDb.select().from(accessReviewSchedules).where(eq(accessReviewSchedules.id, id)).limit(1));
  if (!row) throw new ApiClientError("Access review schedule not found", 404);
  const current: ScheduleFields = {
    name: row.name,
    enabled: row.enabled,
    scope: parseStoredScope(row.scope),
    reviewerIds: parseStoredIds(row.reviewerIds),
    durationDays: row.durationDays,
    intervalMonths: row.intervalMonths,
  };
  const { fields } = await readFields(input, current);
  // Re-enabling a schedule whose next run passed while it was off starts from now.
  const nextRunAt = fields.enabled && !row.enabled && new Date(row.nextRunAt).getTime() < Date.now()
    ? new Date().toISOString()
    : row.nextRunAt;
  await appDb.update(accessReviewSchedules)
    .set({ ...columns(fields), nextRunAt, updatedAt: nowIso() })
    .where(eq(accessReviewSchedules.id, id));
  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "access_review_schedule",
    entityId: id,
    summary: `Updated access review schedule "${fields.name}"${fields.enabled !== row.enabled ? (fields.enabled ? " (enabled)" : " (disabled)") : ""}`,
    data: { before: current, after: fields },
  });
  return await getSchedule(id);
}

/** Deletes a schedule; campaigns it started stay. */
export async function deleteSchedule(id: number, actorUserId: number): Promise<void> {
  const row = await first(appDb.select().from(accessReviewSchedules).where(eq(accessReviewSchedules.id, id)).limit(1));
  if (!row) throw new ApiClientError("Access review schedule not found", 404);
  await appDb.delete(accessReviewSchedules).where(eq(accessReviewSchedules.id, id));
  await logAuditEvent({
    userId: actorUserId,
    action: "delete",
    entityType: "access_review_schedule",
    entityId: id,
    summary: `Deleted access review schedule "${row.name}"`,
  });
}
