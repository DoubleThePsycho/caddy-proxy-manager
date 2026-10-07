// SPDX-License-Identifier: Elastic-2.0
/**
 * Access review campaigns: starting one (a snapshot of every access of the
 * users in scope), reading them, and closing, cancelling or deleting them.
 */
import { and, eq, inArray } from "drizzle-orm";
import { appDb, nowIso, toIso } from "@/src/lib/db";
import { accessReviewCampaigns, accessReviewItems } from "@/src/lib/db/schema";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import {
  accessOf,
  describeReviewers,
  parseStoredIds,
  parseStoredScope,
  readName,
  readReviewerIds,
  readScope,
  rejectUnknownKeys,
  requireRecord,
  usersInScope,
  type ReviewReader,
  type ReviewWriter,
} from "./scope";
import {
  type CampaignCounts,
  type CampaignDetail,
  type CampaignStatus,
  type CampaignSummary,
  type Decision,
  type ItemKind,
  type ItemOutcome,
  type ReviewItemView,
  type ReviewScope,
} from "./types";
import { asc, desc, first } from "@/src/lib/db/ops";

type CampaignRow = typeof accessReviewCampaigns.$inferSelect;
type ItemRow = typeof accessReviewItems.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_DURATION_DAYS = 366;

export type CampaignInput = {
  name: string;
  scope: ReviewScope;
  reviewerIds: number[];
  dueAt: string;
};

function isOverdue(row: Pick<CampaignRow, "status" | "dueAt">, now: Date): boolean {
  return row.status === "open" && new Date(row.dueAt).getTime() < now.getTime();
}

export function toItemView(row: ItemRow, campaign: Pick<CampaignRow, "status" | "dueAt">, now = new Date()): ReviewItemView {
  return {
    id: row.id,
    campaignId: row.campaignId,
    subjectUserId: row.subjectUserId,
    subjectEmail: row.subjectEmail,
    subjectName: row.subjectName,
    kind: row.kind as ItemKind,
    targetId: row.targetId,
    targetLabel: row.targetLabel,
    decision: (row.decision === "keep" || row.decision === "revoke" ? row.decision : null) as Decision | null,
    comment: row.comment,
    decidedBy: row.decidedBy,
    decidedByEmail: row.decidedByEmail,
    decidedAt: row.decidedAt ? toIso(row.decidedAt) : null,
    confirmedAt: row.confirmedAt ? toIso(row.confirmedAt) : null,
    outcome: (row.outcome ?? null) as ItemOutcome | null,
    outcomeDetail: row.outcomeDetail,
    overdue: row.confirmedAt === null && row.outcome === null && isOverdue(campaign, now),
  };
}

function countItems(items: readonly ItemRow[], reviewerIds: readonly number[]): CampaignCounts {
  const counts: CampaignCounts = {
    total: items.length, pending: 0, drafted: 0, kept: 0, revoked: 0, unchanged: 0, failed: 0, notReviewed: 0, unreviewable: 0,
  };
  for (const item of items) {
    if (item.confirmedAt === null && item.outcome === null) {
      counts.pending++;
      if (item.decision) counts.drafted++;
      if (!reviewerIds.some((id) => id !== item.subjectUserId)) counts.unreviewable++;
      continue;
    }
    switch (item.outcome) {
      case "kept": counts.kept++; break;
      case "revoked": counts.revoked++; break;
      case "unchanged": counts.unchanged++; break;
      case "failed": counts.failed++; break;
      case "not_reviewed": counts.notReviewed++; break;
    }
  }
  return counts;
}

async function toSummary(reader: ReviewReader, row: CampaignRow, items: readonly ItemRow[], now: Date): Promise<CampaignSummary> {
  const reviewerIds = parseStoredIds(row.reviewerIds);
  const counts = countItems(items, reviewerIds);
  return {
    id: row.id,
    name: row.name,
    status: row.status as CampaignStatus,
    overdue: isOverdue(row, now) && counts.pending > 0,
    scope: parseStoredScope(row.scope),
    reviewers: await describeReviewers(reader, reviewerIds),
    dueAt: toIso(row.dueAt)!,
    startedAt: toIso(row.startedAt)!,
    completedAt: row.completedAt ? toIso(row.completedAt) : null,
    cancelledAt: row.cancelledAt ? toIso(row.cancelledAt) : null,
    scheduleId: row.scheduleId,
    createdBy: row.createdBy,
    counts,
  };
}

export async function listCampaigns(): Promise<CampaignSummary[]> {
  const rows = await appDb.select().from(accessReviewCampaigns).orderBy(desc(accessReviewCampaigns.startedAt), desc(accessReviewCampaigns.id));
  if (rows.length === 0) return [];
  const items = await appDb.select().from(accessReviewItems).where(inArray(accessReviewItems.campaignId, rows.map((row) => row.id)));
  const byCampaign = new Map<number, ItemRow[]>();
  for (const item of items) byCampaign.set(item.campaignId, [...(byCampaign.get(item.campaignId) ?? []), item]);
  const now = new Date();
  return Promise.all(rows.map((row) => toSummary(appDb, row, byCampaign.get(row.id) ?? [], now)));
}

export async function readCampaign(reader: ReviewReader, id: number): Promise<CampaignDetail | null> {
  const row = await first(reader.select().from(accessReviewCampaigns).where(eq(accessReviewCampaigns.id, id)).limit(1));
  if (!row) return null;
  const items = await reader
    .select()
    .from(accessReviewItems)
    .where(eq(accessReviewItems.campaignId, id))
    .orderBy(asc(accessReviewItems.subjectEmail), asc(accessReviewItems.id));
  const now = new Date();
  return { ...await toSummary(reader, row, items, now), items: items.map((item) => toItemView(item, row, now)) };
}

export async function getCampaign(id: number): Promise<CampaignDetail> {
  const campaign = await readCampaign(appDb, id);
  if (!campaign) throw new ApiClientError("Access review not found", 404);
  return campaign;
}

/** Validates a campaign request: {name, scope, reviewerIds, dueAt}. */
export async function readCampaignInput(input: unknown, reader: ReviewReader = appDb, now = new Date()): Promise<CampaignInput> {
  const body = requireRecord(input);
  rejectUnknownKeys(body, ["name", "scope", "reviewerIds", "dueAt"]);
  const name = readName(body.name);
  const scope = await readScope(body.scope, reader);
  const reviewerIds = await readReviewerIds(body.reviewerIds, reader);
  if (typeof body.dueAt !== "string") throw new ApiValidationError("dueAt must be an ISO 8601 date");
  const due = new Date(body.dueAt);
  if (Number.isNaN(due.getTime())) throw new ApiValidationError("dueAt must be an ISO 8601 date");
  if (due.getTime() <= now.getTime()) throw new ApiValidationError("dueAt must be in the future");
  if (due.getTime() > now.getTime() + MAX_DURATION_DAYS * DAY_MS) {
    throw new ApiValidationError(`dueAt must be within ${MAX_DURATION_DAYS} days`);
  }
  return { name, scope, reviewerIds, dueAt: due.toISOString() };
}

/**
 * The users in scope; refuses a user in scope who is the only reviewer
 * (nobody else could review their access).
 */
export async function assertReviewable(reader: ReviewReader, scope: ReviewScope, reviewerIds: readonly number[]) {
  const subjects = await usersInScope(reader, scope);
  const alone = subjects.find((user) => !reviewerIds.some((id) => id !== user.id));
  if (alone) {
    throw new ApiValidationError(
      `${alone.email} is in the scope and the only reviewer, and nobody may review their own access; add another reviewer`
    );
  }
  return subjects;
}

/**
 * Creates the campaign and its items inside `tx`. Refuses a scope with no
 * user, and a user in scope who is the only reviewer (nobody else could
 * review their access). Returns the campaign id and item count.
 */
export async function insertCampaign(
  tx: ReviewWriter,
  input: CampaignInput,
  meta: { createdBy: number | null; scheduleId: number | null },
  options: { allowUnreviewable?: boolean } = {}
): Promise<{ id: number; items: number; users: number }> {
  const subjects = options.allowUnreviewable ? await usersInScope(tx, input.scope) : await assertReviewable(tx, input.scope, input.reviewerIds);
  if (subjects.length === 0) throw new ApiValidationError("No active user is in the scope of this review");
  const now = nowIso();
  const campaign = (await first(tx
    .insert(accessReviewCampaigns)
    .values({
      name: input.name,
      status: "open",
      scope: JSON.stringify(input.scope),
      reviewerIds: JSON.stringify(input.reviewerIds),
      dueAt: input.dueAt,
      startedAt: now,
      scheduleId: meta.scheduleId,
      createdBy: meta.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .returning()))!;
  let items = 0;
  for (const user of subjects) {
    for (const access of await accessOf(tx, user)) {
      await tx.insert(accessReviewItems)
        .values({
          campaignId: campaign.id,
          subjectUserId: user.id,
          subjectEmail: user.email,
          subjectName: user.name,
          kind: access.kind,
          targetId: access.targetId,
          targetLabel: access.targetLabel,
          createdAt: now,
          updatedAt: now,
        });
      items++;
    }
  }
  return { id: campaign.id, items, users: subjects.length };
}

export async function auditCampaignStarted(
  actorUserId: number | null,
  campaign: { id: number; name: string; items: number; users: number; dueAt: string; scheduleId: number | null }
): Promise<void> {
  await logAuditEvent({
    userId: actorUserId,
    action: "access_review_started",
    entityType: "access_review",
    entityId: campaign.id,
    summary: `Started access review "${campaign.name}": ${campaign.items} item(s) for ${campaign.users} user(s), due ${campaign.dueAt.slice(0, 10)}` +
      (campaign.scheduleId !== null ? ` (schedule ${campaign.scheduleId})` : ""),
    data: { items: campaign.items, users: campaign.users, dueAt: campaign.dueAt, scheduleId: campaign.scheduleId },
  });
}

/** Starts a campaign now. */
export async function startCampaign(input: unknown, actorUserId: number): Promise<CampaignDetail> {
  const parsed = await readCampaignInput(input);
  const created = await appDb.transaction(async (tx) => await insertCampaign(tx, parsed, { createdBy: actorUserId, scheduleId: null }));
  await auditCampaignStarted(actorUserId, { ...created, name: parsed.name, dueAt: parsed.dueAt, scheduleId: null });
  return await getCampaign(created.id);
}

function counts(items: readonly ItemRow[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const item of items) {
    const key = item.outcome ?? "pending";
    summary[key] = (summary[key] ?? 0) + 1;
  }
  return summary;
}

/**
 * Closes open campaign `id` inside `tx`: items nobody confirmed are recorded
 * as not reviewed (their access is left as it is). Returns the campaign and
 * its items for the audit event, or null when it is not open.
 */
export async function closeCampaign(tx: ReviewWriter, id: number): Promise<{ row: CampaignRow; items: ItemRow[] } | null> {
  const row = await first(tx.select().from(accessReviewCampaigns).where(eq(accessReviewCampaigns.id, id)).limit(1));
  if (!row || row.status !== "open") return null;
  const now = nowIso();
  const undecided = (await tx
    .select({ id: accessReviewItems.id, confirmedAt: accessReviewItems.confirmedAt, outcome: accessReviewItems.outcome })
    .from(accessReviewItems)
    .where(eq(accessReviewItems.campaignId, id)))
    .filter((item) => item.confirmedAt === null && item.outcome === null)
    .map((item) => item.id);
  if (undecided.length > 0) {
    await tx.update(accessReviewItems)
      .set({ outcome: "not_reviewed", updatedAt: now })
      .where(inArray(accessReviewItems.id, undecided));
  }
  await tx.update(accessReviewCampaigns)
    .set({ status: "completed", completedAt: now, updatedAt: now })
    .where(eq(accessReviewCampaigns.id, id));
  return { row, items: await tx.select().from(accessReviewItems).where(eq(accessReviewItems.campaignId, id)).orderBy(accessReviewItems.id) };
}

/** Closes an open campaign early (see closeCampaign). */
export async function completeCampaign(id: number, actorUserId: number): Promise<CampaignDetail> {
  const result = await appDb.transaction(async (tx) => {
    const row = await first(tx.select({ status: accessReviewCampaigns.status }).from(accessReviewCampaigns).where(eq(accessReviewCampaigns.id, id)).limit(1));
    if (!row) throw new ApiClientError("Access review not found", 404);
    if (row.status !== "open") throw new ApiClientError(`This access review is already ${row.status}`, 409);
    return (await closeCampaign(tx, id))!;
  });
  await auditCampaignCompleted(actorUserId, result.row, result.items);
  return await getCampaign(id);
}

export async function auditCampaignCompleted(actorUserId: number | null, row: Pick<CampaignRow, "id" | "name">, items: readonly ItemRow[]): Promise<void> {
  const summary = counts(items);
  await logAuditEvent({
    userId: actorUserId,
    action: "access_review_completed",
    entityType: "access_review",
    entityId: row.id,
    summary: `Completed access review "${row.name}": ${summary.kept ?? 0} kept, ${summary.revoked ?? 0} revoked, ` +
      `${summary.unchanged ?? 0} unchanged, ${summary.failed ?? 0} failed, ${summary.not_reviewed ?? 0} not reviewed`,
    data: { outcomes: summary },
  });
}

/** Stops an open campaign; nothing is revoked any more. */
export async function cancelCampaign(id: number, actorUserId: number): Promise<CampaignDetail> {
  const row = await first(appDb.select().from(accessReviewCampaigns).where(eq(accessReviewCampaigns.id, id)).limit(1));
  if (!row) throw new ApiClientError("Access review not found", 404);
  if (row.status !== "open") throw new ApiClientError(`This access review is already ${row.status}`, 409);
  const now = nowIso();
  // Only while it is still open: a review completed meanwhile stays completed.
  const cancelled = await appDb.update(accessReviewCampaigns)
    .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
    .where(and(eq(accessReviewCampaigns.id, id), eq(accessReviewCampaigns.status, "open")))
    .returning({ id: accessReviewCampaigns.id });
  if (cancelled.length === 0) {
    const current = await first(appDb.select({ status: accessReviewCampaigns.status }).from(accessReviewCampaigns).where(eq(accessReviewCampaigns.id, id)).limit(1));
    throw new ApiClientError(current ? `This access review is already ${current.status}` : "Access review not found", current ? 409 : 404);
  }
  await logAuditEvent({
    userId: actorUserId,
    action: "access_review_cancelled",
    entityType: "access_review",
    entityId: id,
    summary: `Cancelled access review "${row.name}"`,
  });
  return await getCampaign(id);
}

/** Deletes a campaign and its items (and with them its record). */
export async function deleteCampaign(id: number, actorUserId: number): Promise<void> {
  const row = await first(appDb.select().from(accessReviewCampaigns).where(eq(accessReviewCampaigns.id, id)).limit(1));
  if (!row) throw new ApiClientError("Access review not found", 404);
  await appDb.transaction(async (tx) => {
    await tx.delete(accessReviewItems).where(eq(accessReviewItems.campaignId, id));
    await tx.delete(accessReviewCampaigns).where(eq(accessReviewCampaigns.id, id));
  });
  await logAuditEvent({
    userId: actorUserId,
    action: "delete",
    entityType: "access_review",
    entityId: id,
    summary: `Deleted access review "${row.name}" (${row.status})`,
    data: { status: row.status },
  });
}
