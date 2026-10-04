// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { verifyAuditLog } from "@/ee/audit/verify";
import { NO_STORE } from "@/ee/audit/http";
import { assertProviderLevel } from "@/ee/multi-tenancy/scope";

export async function GET(request: NextRequest) {
  try {
    const { userId, access } = await requireApiPermission(request, "audit_log:read");
    // The hash chain spans every organisation's events (ee/multi-tenancy).
    assertProviderLevel(access, "Verifying the audit log is done by your provider");
    return NextResponse.json(await verifyAuditLog(userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
