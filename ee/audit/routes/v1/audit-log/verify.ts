// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { verifyAuditLog } from "@/ee/audit/verify";
import { NO_STORE } from "@/ee/audit/http";

export async function GET(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "audit_log:read");
    return NextResponse.json(await verifyAuditLog(userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
