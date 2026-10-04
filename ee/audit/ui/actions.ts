// SPDX-License-Identifier: Elastic-2.0
"use server";

import { requirePermission } from "@/src/lib/auth";
import { ApiClientError } from "@/src/lib/api-errors";
import { verifyAuditLog } from "@/ee/audit/verify";
import type { AuditVerification } from "@/ee/audit/types";
import { assertProviderLevel } from "@/ee/multi-tenancy/scope";

/** Verifies the audit log's hash chain from the Audit log page (audit_streaming), as GET /api/v1/audit-log/verify does. */
export async function verifyAuditLogAction(): Promise<{ result: AuditVerification } | { error: string }> {
  const session = await requirePermission("audit_log:read");
  try {
    // The hash chain spans every organisation's events (ee/multi-tenancy).
    assertProviderLevel(session.access, "Verifying the audit log is done by your provider");
    return { result: await verifyAuditLog(Number(session.user.id)) };
  } catch (error) {
    if (error instanceof ApiClientError) return { error: error.message };
    throw error;
  }
}
