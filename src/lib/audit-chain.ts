/**
 * Tamper-evident hash chain over the audit log.
 *
 * Every event is inserted together with
 *
 *   hash = sha256_hex(prevHash + canonicalJson(event))
 *
 * where prevHash is the hash of the newest event that has one. Changing,
 * inserting or deleting an event in the middle of the log breaks the chain
 * from that event on. Events recorded before the chain existed keep NULL
 * hashes; the chain starts at the first event recorded after the upgrade.
 *
 * The hash does not depend on the row id. It covers `actorDigest` instead of
 * `userId`: deleting a user clears userId on that user's events (ids are
 * reused, see deleteUserReferences), and the digest keeps those events
 * verifiable while a changed userId is still detected.
 */
import { createHash } from "node:crypto";
import { isNotNull } from "drizzle-orm";
import { appDb, nowIso } from "./db";
import { auditEvents } from "./db/schema";
import { configLinksForEvent, type ConfigLinks } from "@/ee/config-history/links";
import { inTransaction } from "@/src/lib/db/executor";
import { desc, first, recoverable } from "@/src/lib/db/ops";
import type { AppDb } from "@/src/lib/db/types";

export const AUDIT_CHAIN_VERSION = 1;

export type AuditEventInput = {
  userId?: number | null;
  action: string;
  entityType: string;
  entityId?: number | null;
  summary?: string | null;
  /** Already serialized (usually JSON). */
  data?: string | null;
};

/** The stored fields the hash covers. */
export type HashedAuditFields = {
  createdAt: string;
  actorDigest: string | null;
  action: string;
  entityType: string;
  entityId: number | null;
  summary: string | null;
  data: string | null;
};

export function auditActorDigest(userId: number | null | undefined): string | null {
  if (userId === null || userId === undefined) return null;
  return createHash("sha256").update(`audit-actor:${userId}`).digest("hex");
}

/** Key order is fixed, so the same fields always give the same string. */
export function canonicalAuditJson(fields: HashedAuditFields): string {
  return JSON.stringify({
    v: AUDIT_CHAIN_VERSION,
    createdAt: fields.createdAt,
    actor: fields.actorDigest,
    action: fields.action,
    entityType: fields.entityType,
    entityId: fields.entityId,
    summary: fields.summary,
    data: fields.data,
  });
}

export function computeAuditHash(prevHash: string | null, fields: HashedAuditFields): string {
  return createHash("sha256")
    .update(prevHash ?? "")
    .update(canonicalAuditJson(fields))
    .digest("hex");
}

/**
 * Inserts an audit event and links it into the hash chain in one
 * transaction. Returns the new event's id. Throws on database errors.
 */
export async function insertAuditEvent(input: AuditEventInput): Promise<number> {
  const userId = input.userId ?? null;
  const fields: HashedAuditFields = {
    createdAt: nowIso(),
    actorDigest: auditActorDigest(userId),
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    summary: input.summary ?? null,
    data: input.data ?? null,
  };
  const link = async (tx: Pick<AppDb, "select" | "insert">): Promise<number> => {
      // Configuration history versions around a configuration change (not hashed).
      let links: ConfigLinks = { configBeforeId: null, configAfterId: null, changeRequestId: null };
      try {
        // In a savepoint of its own: a failed lookup does not take the event with it.
        links = await recoverable(async () => await configLinksForEvent(tx as unknown as Parameters<typeof configLinksForEvent>[0], {
          action: fields.action,
          entityType: fields.entityType,
          entityId: fields.entityId,
        }));
      } catch {
        // Never keep an event from being recorded.
      }
      const latest = await first(tx
        .select({ hash: auditEvents.hash })
        .from(auditEvents)
        .where(isNotNull(auditEvents.hash))
        .orderBy(desc(auditEvents.id))
        .limit(1));
      const prevHash = latest?.hash ?? null;
      const row = (await first(tx
        .insert(auditEvents)
        .values({
          userId,
          ...fields,
          ...links,
          prevHash,
          hash: computeAuditHash(prevHash, fields),
        })
        .returning({ id: auditEvents.id })))!;
      return row.id;
  };
  // The chain needs "read the newest hash, insert" to be atomic: a
  // transaction of its own, or, when the caller already runs in one (the
  // ambient transaction, src/lib/db/executor.ts), a savepoint in it, so a
  // failure here rolls back alone and never aborts the caller's transaction.
  if (inTransaction()) return await appDb.transaction(async (tx) => await link(tx));
  return await appDb.transaction(async (tx) => await link(tx), { behavior: "immediate" });
}
