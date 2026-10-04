// SPDX-License-Identifier: Elastic-2.0
/**
 * Verification of the audit log's hash chain (src/lib/audit-chain.ts).
 *
 * Retention deletes the oldest events, so the oldest remaining chained event
 * is the anchor: its prevHash is trusted, and every later event must link to
 * the one before it and hash to its stored value. Deleting the newest events
 * leaves a valid (shorter) chain; compare headHash with a streamed or exported
 * copy to detect that.
 */
import { gt, lte, and } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { auditEvents } from "@/src/lib/db/schema";
import { auditActorDigest, computeAuditHash } from "@/src/lib/audit-chain";
import { logAuditEvent } from "@/src/lib/audit";
import { requireFeature } from "@/ee/licensing/store";
import { latestAuditEventId } from "./records";
import type { AuditVerification } from "./types";
import { asc } from "@/src/lib/db/ops";

const PAGE_SIZE = 1000;

export async function verifyAuditChain(now: Date = new Date()): Promise<AuditVerification> {
  const result: AuditVerification = {
    ok: true,
    checked: 0,
    firstMismatchId: null,
    reason: null,
    anchoredAt: null,
    anchorId: null,
    anchorHash: null,
    headId: null,
    headHash: null,
    unchainedEvents: 0,
    verifiedAt: now.toISOString(),
  };
  // Events recorded while verifying are left for the next run.
  const maxId = await latestAuditEventId();
  let started = false;
  let expectedPrev: string | null = null;
  let afterId = 0;

  const fail = (id: number, reason: string) => {
    result.ok = false;
    result.firstMismatchId = id;
    result.reason = reason;
  };

  while (afterId < maxId) {
    const rows = await appDb
      .select()
      .from(auditEvents)
      .where(and(gt(auditEvents.id, afterId), lte(auditEvents.id, maxId)))
      .orderBy(asc(auditEvents.id))
      .limit(PAGE_SIZE);
    if (rows.length === 0) break;
    for (const row of rows) {
      afterId = row.id;
      if (row.hash === null) {
        if (!started) {
          result.unchainedEvents += 1;
          continue;
        }
        result.checked += 1;
        fail(row.id, "The event has no hash although the hash chain had already started");
        return result;
      }
      if (!started) {
        started = true;
        expectedPrev = row.prevHash;
        result.anchorId = row.id;
        result.anchoredAt = row.createdAt;
        result.anchorHash = row.prevHash;
      }
      result.checked += 1;
      if (row.prevHash !== expectedPrev) {
        fail(row.id, "The event does not link to the event before it: an earlier event was changed, removed or inserted");
        return result;
      }
      const hash = computeAuditHash(row.prevHash, {
        createdAt: row.createdAt,
        actorDigest: row.actorDigest,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        summary: row.summary,
        data: row.data,
      });
      if (hash !== row.hash) {
        fail(row.id, "The event's contents do not match its hash");
        return result;
      }
      // userId is cleared when a user is deleted; any other change shows here.
      if (row.userId !== null && auditActorDigest(row.userId) !== row.actorDigest) {
        fail(row.id, "The event's user does not match the user it was recorded with");
        return result;
      }
      expectedPrev = row.hash;
      result.headId = row.id;
      result.headHash = row.hash;
    }
  }
  return result;
}

/** Checks the license, verifies the chain and records the check in the audit log. */
export async function verifyAuditLog(actorUserId: number): Promise<AuditVerification> {
  await requireFeature("audit_streaming");
  const result = await verifyAuditChain();
  await logAuditEvent({
    userId: actorUserId,
    action: "audit_log_verified",
    entityType: "audit_log",
    summary: result.ok
      ? `Verified the audit log hash chain: ${result.checked} event${result.checked === 1 ? "" : "s"} intact`
      : `Verified the audit log hash chain: mismatch at event #${result.firstMismatchId}`,
    data: {
      ok: result.ok,
      checked: result.checked,
      firstMismatchId: result.firstMismatchId,
      headId: result.headId,
      headHash: result.headHash,
    },
  });
  return result;
}
