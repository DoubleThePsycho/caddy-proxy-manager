"use server";

import { requirePermission } from "@/src/lib/auth";
import { ApiClientError } from "@/src/lib/api-errors";
import { getAuditEventRecord } from "@/src/lib/models/audit";
import { previousChainedEventId } from "@/ee/audit/chain-status";
import { auditEventConfigDiff } from "@/ee/config-history/versions";
import type { AuditEventDetail } from "@/src/lib/audit-log-view";

const EVENT_NOT_FOUND = "Audit event not found";

/**
 * One event's data and, for a configuration change, its before/after diff
 * (secrets masked), with the event before it in the chain, as
 * GET /api/v1/audit-log/{id} returns them.
 */
export async function getAuditEventDetailAction(id: number): Promise<{ detail: AuditEventDetail } | { error: string }> {
  await requirePermission("audit_log:read");
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return { error: EVENT_NOT_FOUND };
  try {
    const event = await getAuditEventRecord(id);
    if (!event) return { error: EVENT_NOT_FOUND };
    const configDiff = await auditEventConfigDiff(event);
    const previousEventId = await previousChainedEventId(event.id, event.prevHash);
    return { detail: { id: event.id, data: event.data, configDiff, previousEventId } };
  } catch (error) {
    if (error instanceof ApiClientError) return { error: error.message };
    throw error;
  }
}
