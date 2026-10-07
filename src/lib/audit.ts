import { insertAuditEvent } from "./audit-chain";
import { inChangeBatch } from "./change-batch";

/**
 * Records an audit event, linked into the audit log's hash chain. Never
 * rejects: a failure is logged and the caller carries on. Await it: inside a
 * transaction the event is part of it (a savepoint, src/lib/audit-chain.ts). Inside a
 * change batch (change-batch.ts) nothing is recorded.
 */
export async function logAuditEvent(params: {
  userId?: number | null;
  action: string;
  entityType: string;
  entityId?: number | null;
  summary?: string | null;
  data?: unknown;
}) {
  // A change batch records one event summarising all of its changes.
  if (inChangeBatch()) return;
  try {
    // It runs in a savepoint of its own inside a transaction, so a failure
    // here leaves the caller's transaction going (on PostgreSQL a failed
    // statement would abort it).
    await insertAuditEvent({
      userId: params.userId ?? null,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId ?? null,
      summary: params.summary ?? null,
      data: params.data ? JSON.stringify(params.data) : null,
    });
  } catch (error) {
    // Log error but don't throw to avoid breaking the main flow
    console.error("Failed to log audit event:", error);
  }
}
