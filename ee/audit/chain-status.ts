// SPDX-License-Identifier: Elastic-2.0
/**
 * What the audit log page shows about the hash chain without verifying it
 * again: the last recorded verification (an `audit_log_verified` event, by a
 * person, the API or a report schedule), how many events were recorded since,
 * and the chain's anchor and head as they are now.
 *
 * Read-only; verifying again is in verify.ts.
 */
import { and, count, eq, gt, isNotNull, lt } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { auditEvents } from "@/src/lib/db/schema";
import { asc, desc } from "@/src/lib/db/ops";

export type AuditChainCheck = {
  /** The audit event that recorded the verification. */
  eventId: number;
  at: string;
  /** Recorded by a user (null: a report schedule or the system). */
  byUserId: number | null;
  ok: boolean;
  checked: number | null;
  firstMismatchId: number | null;
  headId: number | null;
  headHash: string | null;
};

export type AuditChainStatus = {
  lastCheck: AuditChainCheck | null;
  /** Events recorded after the event of the last check (all events when there was none). */
  eventsSinceCheck: number;
  /** The oldest event still in the chain, where verification starts. */
  anchor: { id: number; at: string } | null;
  /** The newest chained event. */
  head: { id: number; at: string; hash: string } | null;
};

function readCheck(row: { id: number; createdAt: string; userId: number | null; data: string | null }): AuditChainCheck {
  let data: Record<string, unknown> = {};
  try {
    const parsed = row.data ? JSON.parse(row.data) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    // An unreadable record counts as a check without details.
  }
  const integer = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) ? value : null);
  const hash = (value: unknown) => (typeof value === "string" && /^[0-9a-f]{64}$/i.test(value) ? value : null);
  return {
    eventId: row.id,
    at: row.createdAt,
    byUserId: row.userId,
    ok: data.ok === true,
    checked: integer(data.checked),
    firstMismatchId: integer(data.firstMismatchId),
    headId: integer(data.headId),
    headHash: hash(data.headHash),
  };
}

export async function getAuditChainStatus(): Promise<AuditChainStatus> {
  const [checkRow] = await appDb
    .select({ id: auditEvents.id, createdAt: auditEvents.createdAt, userId: auditEvents.userId, data: auditEvents.data })
    .from(auditEvents)
    .where(eq(auditEvents.action, "audit_log_verified"))
    .orderBy(desc(auditEvents.id))
    .limit(1);
  const lastCheck = checkRow ? readCheck(checkRow) : null;
  const [[since], [anchor], [head]] = await Promise.all([
    appDb
      .select({ value: count() })
      .from(auditEvents)
      .where(lastCheck ? gt(auditEvents.id, lastCheck.eventId) : undefined),
    appDb
      .select({ id: auditEvents.id, at: auditEvents.createdAt })
      .from(auditEvents)
      .where(isNotNull(auditEvents.hash))
      .orderBy(asc(auditEvents.id))
      .limit(1),
    appDb
      .select({ id: auditEvents.id, at: auditEvents.createdAt, hash: auditEvents.hash })
      .from(auditEvents)
      .where(isNotNull(auditEvents.hash))
      .orderBy(desc(auditEvents.id))
      .limit(1),
  ]);
  return {
    lastCheck,
    eventsSinceCheck: since?.value ?? 0,
    anchor: anchor ?? null,
    head: head && head.hash ? { id: head.id, at: head.at, hash: head.hash } : null,
  };
}

/**
 * The chained event before event `id`, when its hash is `prevHash` (the link
 * holds); null otherwise.
 */
export async function previousChainedEventId(id: number, prevHash: string | null): Promise<number | null> {
  if (!prevHash) return null;
  const [row] = await appDb
    .select({ id: auditEvents.id, hash: auditEvents.hash })
    .from(auditEvents)
    .where(and(lt(auditEvents.id, id), isNotNull(auditEvents.hash)))
    .orderBy(desc(auditEvents.id))
    .limit(1);
  return row && row.hash === prevHash ? row.id : null;
}
