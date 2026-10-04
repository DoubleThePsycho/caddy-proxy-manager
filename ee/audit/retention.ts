// SPDX-License-Identifier: Elastic-2.0
/**
 * Audit log retention. Setting it needs the audit_streaming feature, except
 * setting it back to 0 (keep forever), which winds it down. The daily job
 * that applies it runs whatever the license state.
 */
import { count, gte, lt, max, min } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { auditEvents } from "@/src/lib/db/schema";
import { getSetting, setSetting } from "@/src/lib/settings";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiValidationError } from "@/src/lib/api-errors";
import { requireFeature } from "@/ee/licensing/store";
import type { AuditRetentionView } from "./types";

/** Master-only; deliberately not part of instance sync. */
export const AUDIT_RETENTION_KEY = "audit_retention";
const AUDIT_RETENTION_STATUS_KEY = "audit_retention_status";
export const MAX_RETENTION_DAYS = 36_500;
const DAY_MS = 24 * 60 * 60 * 1000;

type StoredRetention = { days?: unknown };
type StoredStatus = { lastRunAt?: unknown; lastDeleted?: unknown };

function storedDays(value: StoredRetention | null): number {
  const days = value?.days;
  return typeof days === "number" && Number.isInteger(days) && days >= 0 && days <= MAX_RETENTION_DAYS ? days : 0;
}

export async function getAuditRetention(): Promise<AuditRetentionView> {
  const [settings, status] = await Promise.all([
    getSetting<StoredRetention>(AUDIT_RETENTION_KEY),
    getSetting<StoredStatus>(AUDIT_RETENTION_STATUS_KEY),
  ]);
  return {
    days: storedDays(settings),
    lastRunAt: typeof status?.lastRunAt === "string" ? status.lastRunAt : null,
    lastDeleted: typeof status?.lastDeleted === "number" ? status.lastDeleted : null,
  };
}

export function parseRetentionDays(body: unknown): number {
  const days = (body as { days?: unknown } | null)?.days;
  if (typeof body !== "object" || body === null || typeof days !== "number" || !Number.isInteger(days)) {
    throw new ApiValidationError('Body must be {"days": <whole number of days, 0 keeps events forever>}');
  }
  if (days < 0 || days > MAX_RETENTION_DAYS) {
    throw new ApiValidationError(`days must be between 0 and ${MAX_RETENTION_DAYS}`);
  }
  return days;
}

export async function setAuditRetention(body: unknown, actorUserId: number): Promise<AuditRetentionView> {
  const keepForever = typeof body === "object" && body !== null && (body as { days?: unknown }).days === 0;
  if (!keepForever) await requireFeature("audit_streaming");
  const days = parseRetentionDays(body);
  const previous = await getAuditRetention();
  await setSetting(AUDIT_RETENTION_KEY, { days });
  await logAuditEvent({
    userId: actorUserId,
    action: "audit_retention_updated",
    entityType: "audit_log",
    summary: days === 0 ? "Set audit log retention to keep events forever" : `Set audit log retention to ${days} days`,
    data: { days, previousDays: previous.days },
  });
  return { ...previous, days };
}

/**
 * Deletes events older than the retention period. Only a contiguous run of
 * the oldest events is deleted, and the newest event is always kept, so the
 * hash chain keeps a single anchor and new events still link to it.
 */
export async function pruneAuditEvents(now: Date = new Date()): Promise<number> {
  const { days } = await getAuditRetention();
  if (days === 0) return 0;
  const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
  const [bounds] = await appDb.select({ newest: max(auditEvents.id) }).from(auditEvents);
  const newest = bounds?.newest ?? null;
  let deleted = 0;
  if (newest !== null) {
    const [firstKept] = await appDb
      .select({ id: min(auditEvents.id) })
      .from(auditEvents)
      .where(gte(auditEvents.createdAt, cutoff));
    const keepFrom = Math.min(firstKept?.id ?? newest, newest);
    deleted = await appDb.transaction(async (tx) => {
      const [row] = await tx.select({ value: count() }).from(auditEvents).where(lt(auditEvents.id, keepFrom));
      const value = row?.value ?? 0;
      if (value > 0) await tx.delete(auditEvents).where(lt(auditEvents.id, keepFrom));
      return value;
    });
  }
  await setSetting(AUDIT_RETENTION_STATUS_KEY, { lastRunAt: now.toISOString(), lastDeleted: deleted });
  if (deleted > 0) {
    await logAuditEvent({
      action: "audit_log_pruned",
      entityType: "audit_log",
      summary: `Deleted ${deleted} audit event${deleted === 1 ? "" : "s"} older than ${days} days`,
      data: { deleted, retentionDays: days, before: cutoff },
    });
  }
  return deleted;
}
