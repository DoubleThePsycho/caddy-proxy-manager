import { insertAuditEvent } from "./audit-chain";
import { inChangeBatch } from "./change-batch";
import { auditEventOrganization } from "@/ee/multi-tenancy/audit";

/**
 * Records an audit event, linked into the audit log's hash chain. Never
 * rejects: a failure is logged and the caller carries on. Await it: inside a
 * transaction the event is part of it (a savepoint, src/lib/audit-chain.ts). Inside a
 * change batch (change-batch.ts) nothing is recorded.
 *
 * `organizationId` decides which organisation's audit log shows the event
 * (ee/multi-tenancy); left out, it is the organisation of the entity, or of
 * the user acting.
 */
export async function logAuditEvent(params: {
  userId?: number | null;
  action: string;
  entityType: string;
  entityId?: number | null;
  summary?: string | null;
  data?: unknown;
  organizationId?: number | null;
}) {
  // A change batch records one event summarising all of its changes.
  if (inChangeBatch()) return;
  try {
    // Both run in savepoints of their own inside a transaction, so a failure
    // here leaves the caller's transaction going (on PostgreSQL a failed
    // statement would abort it).
    await insertAuditEvent({
      userId: params.userId ?? null,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId ?? null,
      summary: params.summary ?? null,
      data: params.data ? JSON.stringify(params.data) : null,
      organizationId: params.organizationId !== undefined ? params.organizationId : await auditEventOrganization(params),
    });
  } catch (error) {
    // Log error but don't throw to avoid breaking the main flow
    console.error("Failed to log audit event:", error);
  }
}
