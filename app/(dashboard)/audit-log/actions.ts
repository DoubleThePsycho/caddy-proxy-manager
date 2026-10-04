"use server";

import { requirePermission } from "@/src/lib/auth";
import { ApiClientError } from "@/src/lib/api-errors";
import { tenantOf } from "@/src/lib/permissions";
import { getAuditEventRecord } from "@/src/lib/models/audit";
import { previousChainedEventId } from "@/ee/audit/chain-status";
import { auditEventConfigDiff } from "@/ee/config-history/versions";
import { dashboardOrganizationFilter } from "@/ee/multi-tenancy/view";
import type { AuditEventDetail } from "@/src/lib/audit-log-view";

const EVENT_NOT_FOUND = "Audit event not found";

/**
 * One event's data and, for a configuration change, its before/after diff
 * (secrets masked), as GET /api/v1/audit-log/{id} returns them. Limited to
 * the audit log the dashboard shows the caller: an organisation user never
 * reaches another organisation's events, and only provider-level users learn
 * which event comes before it in the chain (it spans every organisation).
 */
export async function getAuditEventDetailAction(id: number): Promise<{ detail: AuditEventDetail } | { error: string }> {
  const { access } = await requirePermission("audit_log:read");
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return { error: EVENT_NOT_FOUND };
  try {
    const organizationId = await dashboardOrganizationFilter(access);
    const event = await getAuditEventRecord(id, organizationId);
    if (!event) return { error: EVENT_NOT_FOUND };
    const configDiff = await auditEventConfigDiff(event);
    const previousEventId = tenantOf(access) === null ? await previousChainedEventId(event.id, event.prevHash) : null;
    return { detail: { id: event.id, data: event.data, configDiff, previousEventId } };
  } catch (error) {
    if (error instanceof ApiClientError) return { error: error.message };
    throw error;
  }
}
