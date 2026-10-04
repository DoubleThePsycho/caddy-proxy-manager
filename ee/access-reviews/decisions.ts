// SPDX-License-Identifier: Elastic-2.0
/**
 * Reviewers' decisions. A reviewer is any user named on a campaign; being
 * named is what lets them see the campaign's items and decide them, no
 * permission needed. Nobody decides on their own access.
 *
 * A decision is a draft until the reviewer confirms. Confirming applies each
 * revocation through the same model functions as a manual change, with
 * their guards (the last active administrator, enforced SSO's break-glass
 * administrator):
 *  - account: updateUserStatus(user, "disabled") (ends its sessions);
 *  - role: setUserRoleAssignment(user, built-in viewer);
 *  - group: removeGroupMember;
 *  - api_token: deleteApiToken.
 * Access that is gone or changed since the campaign started is left alone
 * and recorded as unchanged. The campaign completes when its last item is
 * confirmed. Never checks the license.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { accessReviewCampaigns, accessReviewItems, users } from "@/src/lib/db/schema";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import { NotFoundError } from "@/src/lib/api-auth";
import { getUserById, setUserRoleAssignment, updateUserStatus } from "@/src/lib/models/user";
import { removeGroupMember } from "@/src/lib/models/groups";
import { deleteApiToken } from "@/src/lib/models/api-tokens";
import { assertActiveAdminRemains } from "@/ee/custom-roles/escalation";
import { auditCampaignCompleted, closeCampaign, toItemView } from "./campaigns";
import { parseStoredIds, rejectUnknownKeys, requireRecord } from "./scope";
import { userOrganizationId } from "@/ee/multi-tenancy/store";
import type { AssignmentView, Decision, ItemOutcome, ReviewItemView } from "./types";
import { asc, first } from "@/src/lib/db/ops";

type ItemRow = typeof accessReviewItems.$inferSelect;
type CampaignRow = typeof accessReviewCampaigns.$inferSelect;

const MAX_COMMENT_LENGTH = 1000;

/**
 * Whether `userId` reviews `campaign`. A user of an organisation
 * (ee/multi-tenancy) never does, even when named before they moved there: a
 * campaign lists users and roles of every organisation.
 */
async function reviews(campaign: CampaignRow, userId: number): Promise<boolean> {
  return parseStoredIds(campaign.reviewerIds).includes(userId) && await userOrganizationId(appDb, userId) === null;
}

/** Whether `userId` is a reviewer of the open campaign `campaignId`. */
export async function reviewsOpenCampaign(userId: number, campaignId: number): Promise<boolean> {
  const campaign = await first(appDb.select().from(accessReviewCampaigns).where(eq(accessReviewCampaigns.id, campaignId)).limit(1));
  return campaign !== undefined && campaign.status === "open" && await reviews(campaign, userId);
}

async function openCampaignsReviewedBy(userId: number): Promise<CampaignRow[]> {
  if (await userOrganizationId(appDb, userId) !== null) return [];
  return (await appDb
    .select()
    .from(accessReviewCampaigns)
    .where(eq(accessReviewCampaigns.status, "open"))
    .orderBy(asc(accessReviewCampaigns.dueAt), asc(accessReviewCampaigns.id)))
    .filter((campaign) => parseStoredIds(campaign.reviewerIds).includes(userId));
}

/** The open campaigns `userId` reviews, with their items (their own access is marked, and not decidable). */
export async function listAssignments(userId: number): Promise<AssignmentView[]> {
  const campaigns = await openCampaignsReviewedBy(userId);
  if (campaigns.length === 0) return [];
  const items = await appDb
    .select()
    .from(accessReviewItems)
    .where(inArray(accessReviewItems.campaignId, campaigns.map((campaign) => campaign.id)))
    .orderBy(asc(accessReviewItems.subjectEmail), asc(accessReviewItems.id));
  const now = new Date();
  return campaigns.map((campaign) => ({
    campaign: {
      id: campaign.id,
      name: campaign.name,
      dueAt: new Date(campaign.dueAt).toISOString(),
      overdue: new Date(campaign.dueAt).getTime() < now.getTime(),
    },
    items: items
      .filter((item) => item.campaignId === campaign.id)
      .map((item) => ({ ...toItemView(item, campaign, now), ownAccess: item.subjectUserId === userId })),
  }));
}

/** Items `userId` still has to decide, and the earliest due date (for the dashboard banner). */
export async function pendingReviewSummary(userId: number): Promise<{ pending: number; dueAt: string | null; overdue: boolean }> {
  let pending = 0;
  let dueAt: string | null = null;
  for (const campaign of await openCampaignsReviewedBy(userId)) {
    const open = (await appDb
      .select({ subjectUserId: accessReviewItems.subjectUserId, decision: accessReviewItems.decision })
      .from(accessReviewItems)
      .where(and(eq(accessReviewItems.campaignId, campaign.id), isNull(accessReviewItems.confirmedAt), isNull(accessReviewItems.outcome))))
      .filter((item) => item.subjectUserId !== userId);
    if (open.length === 0) continue;
    pending += open.length;
    if (dueAt === null || campaign.dueAt < dueAt) dueAt = campaign.dueAt;
  }
  return { pending, dueAt, overdue: dueAt !== null && new Date(dueAt).getTime() < Date.now() };
}

async function loadDecidableItem(userId: number, itemId: number): Promise<{ item: ItemRow; campaign: CampaignRow }> {
  const item = await first(appDb.select().from(accessReviewItems).where(eq(accessReviewItems.id, itemId)).limit(1));
  const campaign = item
    ? await first(appDb.select().from(accessReviewCampaigns).where(eq(accessReviewCampaigns.id, item.campaignId)).limit(1))
    : undefined;
  // Items of campaigns the caller does not review are answered as missing.
  if (!item || !campaign || !await reviews(campaign, userId)) {
    throw new ApiClientError("Review item not found", 404);
  }
  if (campaign.status !== "open") throw new ApiClientError(`This access review is ${campaign.status}`, 409);
  if (item.subjectUserId === userId) throw new ApiClientError("You cannot review your own access", 403);
  if (item.confirmedAt !== null || item.outcome !== null) throw new ApiClientError("This item is already confirmed", 409);
  return { item, campaign };
}

/** Records (or clears, with decision null) a draft decision on an item. */
export async function setDraftDecision(userId: number, itemId: number, input: unknown): Promise<ReviewItemView> {
  const body = requireRecord(input);
  rejectUnknownKeys(body, ["decision", "comment"]);
  const decision = body.decision;
  if (decision !== null && decision !== "keep" && decision !== "revoke") {
    throw new ApiValidationError('decision must be "keep", "revoke" or null');
  }
  let comment: string | null = null;
  if (body.comment !== undefined && body.comment !== null && body.comment !== "") {
    if (typeof body.comment !== "string") throw new ApiValidationError("comment must be a string");
    comment = body.comment.trim();
    if (comment.length > MAX_COMMENT_LENGTH) throw new ApiValidationError(`comment must be at most ${MAX_COMMENT_LENGTH} characters`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(comment)) {
      throw new ApiValidationError("comment must not contain control characters");
    }
  }
  // The checks and the write in one transaction: an item confirmed or a
  // campaign closed meanwhile is never written to.
  return await appDb.transaction(async (tx) => {
    const { item, campaign } = await loadDecidableItem(userId, itemId);
    const reviewer = await first(tx.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1));
    const now = nowIso();
    await tx.update(accessReviewItems)
      .set(decision === null
        ? { decision: null, comment: null, decidedBy: null, decidedByEmail: null, decidedAt: null, updatedAt: now }
        : { decision, comment, decidedBy: userId, decidedByEmail: reviewer?.email ?? null, decidedAt: now, updatedAt: now })
      .where(eq(accessReviewItems.id, item.id));
    const updated = (await first(tx.select().from(accessReviewItems).where(eq(accessReviewItems.id, item.id)).limit(1)))!;
    return toItemView(updated, campaign);
  }, { behavior: "immediate" });
}

type Applied = { outcome: ItemOutcome; detail: string | null };

function guardMessage(error: unknown): string | null {
  return error instanceof ApiClientError ? error.message : null;
}

/** Applies one revocation; never throws for a refusal a guard makes. */
async function revoke(item: ItemRow, reviewerId: number): Promise<Applied> {
  const userId = item.subjectUserId;
  const user = await getUserById(userId);
  if (!user) return { outcome: "unchanged", detail: "The account no longer exists" };
  switch (item.kind as ItemRow["kind"]) {
    case "account": {
      if (user.status !== "active") return { outcome: "unchanged", detail: "The account is already disabled" };
      try {
        await assertActiveAdminRemains(appDb, { userId, status: "disabled" });
        await updateUserStatus(userId, "disabled");
        return { outcome: "revoked", detail: "Account disabled" };
      } catch (error) {
        const message = guardMessage(error);
        if (message) return { outcome: "failed", detail: message };
        throw error;
      }
    }
    case "role": {
      const stillHeld = item.targetId === null
        ? user.role === "admin" && user.customRoleId === null
        : user.customRoleId === item.targetId;
      if (!stillHeld) return { outcome: "unchanged", detail: "The role changed since the review started" };
      try {
        const updated = await setUserRoleAssignment(userId, { role: "viewer", customRoleId: null }, async (tx, current) => {
          const unchanged = item.targetId === null
            ? current.role === "admin" && current.customRoleId === null
            : current.customRoleId === item.targetId;
          if (!unchanged) throw new ApiValidationError("The role changed since the review started");
          await assertActiveAdminRemains(tx, { userId, role: "viewer" });
        });
        if (!updated) return { outcome: "unchanged", detail: "The account no longer exists" };
        return { outcome: "revoked", detail: "Role changed to viewer" };
      } catch (error) {
        const message = guardMessage(error);
        if (message === "The role changed since the review started") return { outcome: "unchanged", detail: message };
        if (message) return { outcome: "failed", detail: message };
        throw error;
      }
    }
    case "group": {
      try {
        await removeGroupMember(item.targetId!, userId, reviewerId);
        return { outcome: "revoked", detail: "Removed from the group" };
      } catch (error) {
        if (error instanceof Error && /not found/i.test(error.message)) {
          return { outcome: "unchanged", detail: "No longer a member of the group" };
        }
        throw error;
      }
    }
    case "api_token": {
      try {
        await deleteApiToken(item.targetId!, userId);
        return { outcome: "revoked", detail: "API token deleted" };
      } catch (error) {
        if (error instanceof NotFoundError) return { outcome: "unchanged", detail: "The API token no longer exists" };
        throw error;
      }
    }
    default:
      return { outcome: "failed", detail: "Unknown access type" };
  }
}

export type ConfirmResult = {
  confirmed: number;
  kept: number;
  revoked: number;
  unchanged: number;
  failed: number;
  campaignCompleted: boolean;
};

/**
 * Confirms every draft decision `userId` made in campaign `campaignId` and
 * applies the revocations. The items are claimed in one transaction first,
 * so confirming twice never applies anything twice.
 */
export async function confirmDecisions(userId: number, input: unknown): Promise<ConfirmResult> {
  const body = requireRecord(input);
  rejectUnknownKeys(body, ["campaignId"]);
  const campaignId = body.campaignId;
  if (typeof campaignId !== "number" || !Number.isSafeInteger(campaignId) || campaignId < 1) {
    throw new ApiValidationError("campaignId must be an access review id");
  }
  const claimedAt = nowIso();
  const { campaign, claimed } = await appDb.transaction(async (tx) => {
    const campaign = await first(tx.select().from(accessReviewCampaigns).where(eq(accessReviewCampaigns.id, campaignId)).limit(1));
    if (!campaign || !await reviews(campaign, userId)) {
      throw new ApiClientError("Access review not found", 404);
    }
    if (campaign.status !== "open") throw new ApiClientError(`This access review is ${campaign.status}`, 409);
    const claimed = (await tx
      .select()
      .from(accessReviewItems)
      .where(and(
        eq(accessReviewItems.campaignId, campaignId),
        eq(accessReviewItems.decidedBy, userId),
        isNull(accessReviewItems.confirmedAt),
        isNull(accessReviewItems.outcome)
      )))
      // Never one's own access, even if a draft somehow names it.
      .filter((item) => item.subjectUserId !== userId && item.decision !== null);
    if (claimed.length > 0) {
      await tx.update(accessReviewItems)
        .set({ confirmedAt: claimedAt, updatedAt: claimedAt })
        .where(inArray(accessReviewItems.id, claimed.map((item) => item.id)));
    }
    return { campaign, claimed };
  });
  if (claimed.length === 0) throw new ApiValidationError("You have no decisions to confirm in this access review");

  const result: ConfirmResult = { confirmed: claimed.length, kept: 0, revoked: 0, unchanged: 0, failed: 0, campaignCompleted: false };
  for (const item of claimed) {
    let applied: Applied;
    if ((item.decision as Decision) === "keep") {
      applied = { outcome: "kept", detail: null };
    } else {
      try {
        applied = await revoke(item, userId);
      } catch (error) {
        console.error("[access-reviews] Revocation failed:", error instanceof Error ? error.name : typeof error);
        applied = { outcome: "failed", detail: "The change could not be applied" };
      }
    }
    await appDb.update(accessReviewItems)
      .set({ outcome: applied.outcome, outcomeDetail: applied.detail, updatedAt: nowIso() })
      .where(eq(accessReviewItems.id, item.id));
    if (applied.outcome === "kept") result.kept++;
    else if (applied.outcome === "revoked") result.revoked++;
    else if (applied.outcome === "unchanged") result.unchanged++;
    else result.failed++;
    if (item.decision === "revoke") {
      await logAuditEvent({
        userId,
        action: "access_review_revoke",
        entityType: "user",
        entityId: item.subjectUserId,
        summary: `Access review "${campaign.name}": revoke ${item.targetLabel} of ${item.subjectEmail}: ${applied.outcome}` +
          (applied.detail ? ` (${applied.detail})` : ""),
        data: { campaignId, itemId: item.id, kind: item.kind, targetId: item.targetId, outcome: applied.outcome, detail: applied.detail },
      });
    }
  }
  await logAuditEvent({
    userId,
    action: "access_review_decisions",
    entityType: "access_review",
    entityId: campaignId,
    summary: `Confirmed ${result.confirmed} decision(s) in access review "${campaign.name}": ${result.kept} kept, ` +
      `${result.revoked} revoked, ${result.unchanged} unchanged, ${result.failed} failed`,
    data: { ...result, itemIds: claimed.map((item) => item.id) },
  });

  // The last confirmation completes the campaign.
  const closed = await appDb.transaction(async (tx) => {
    const remaining = await first(tx
      .select({ id: accessReviewItems.id })
      .from(accessReviewItems)
      .where(and(eq(accessReviewItems.campaignId, campaignId), isNull(accessReviewItems.confirmedAt), isNull(accessReviewItems.outcome)))
      .limit(1));
    return remaining ? null : await closeCampaign(tx, campaignId);
  });
  if (closed) {
    await auditCampaignCompleted(null, closed.row, closed.items);
    result.campaignCompleted = true;
  }
  return result;
}
