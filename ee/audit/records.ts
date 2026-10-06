// SPDX-License-Identifier: Elastic-2.0
import { and, count, eq, gt, gte, lte, max, type SQL } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { auditEvents, users } from "@/src/lib/db/schema";
import { asc } from "@/src/lib/db/ops";

/** An audit event as exported and streamed: the stored row plus who the user is now. */
export type AuditRecord = {
  id: number;
  createdAt: string;
  userId: number | null;
  userEmail: string | null;
  userName: string | null;
  action: string;
  entityType: string;
  entityId: number | null;
  summary: string | null;
  /** The stored data text (usually JSON), exactly as hashed. */
  data: string | null;
  prevHash: string | null;
  hash: string | null;
  actorDigest: string | null;
};

export type AuditRecordRange = {
  /** createdAt lower bound, inclusive (ISO 8601). */
  from?: string | null;
  /** createdAt upper bound, inclusive (ISO 8601). */
  to?: string | null;
  /** Highest id to read. */
  maxId?: number | null;
};

/** Events with id > afterId in id order, at most `limit`. */
export async function readAuditRecords(afterId: number, limit: number, range: AuditRecordRange = {}): Promise<AuditRecord[]> {
  const conditions: SQL[] = [gt(auditEvents.id, afterId)];
  if (range.from) conditions.push(gte(auditEvents.createdAt, range.from));
  if (range.to) conditions.push(lte(auditEvents.createdAt, range.to));
  if (range.maxId !== undefined && range.maxId !== null) conditions.push(lte(auditEvents.id, range.maxId));
  return await appDb
    .select({
      id: auditEvents.id,
      createdAt: auditEvents.createdAt,
      userId: auditEvents.userId,
      userEmail: users.email,
      userName: users.name,
      action: auditEvents.action,
      entityType: auditEvents.entityType,
      entityId: auditEvents.entityId,
      summary: auditEvents.summary,
      data: auditEvents.data,
      prevHash: auditEvents.prevHash,
      hash: auditEvents.hash,
      actorDigest: auditEvents.actorDigest,
    })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.userId))
    .where(and(...conditions))
    .orderBy(asc(auditEvents.id))
    .limit(limit);
}

export async function latestAuditEventId(): Promise<number> {
  const [row] = await appDb.select({ value: max(auditEvents.id) }).from(auditEvents);
  return row?.value ?? 0;
}

/** The oldest event with id > afterId (what a sink delivers next), or null when none waits. */
export async function firstAuditEventAfter(afterId: number): Promise<{ id: number; createdAt: string } | null> {
  const [row] = await appDb
    .select({ id: auditEvents.id, createdAt: auditEvents.createdAt })
    .from(auditEvents)
    .where(gt(auditEvents.id, afterId))
    .orderBy(asc(auditEvents.id))
    .limit(1);
  return row ?? null;
}

export async function countAuditEventsAfter(afterId: number): Promise<number> {
  const [row] = await appDb.select({ value: count() }).from(auditEvents).where(gt(auditEvents.id, afterId));
  return row?.value ?? 0;
}
