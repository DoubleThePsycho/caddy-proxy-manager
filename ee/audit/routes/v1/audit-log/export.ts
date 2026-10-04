// SPDX-License-Identifier: Elastic-2.0
import { NextRequest } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { exportAuditLog } from "@/ee/audit/export";
import { readOrganizationFilterParam } from "@/ee/multi-tenancy/scope";

export async function GET(request: NextRequest) {
  try {
    const { userId, access } = await requireApiPermission(request, "audit_log:read");
    // An organisation user's export holds their organisation's events only (ee/multi-tenancy).
    const organizationId = readOrganizationFilterParam(access, request.nextUrl.searchParams.get("organizationId"));
    const { body, filename, contentType } = await exportAuditLog(request.nextUrl.searchParams, userId, new Date(), organizationId);
    return new Response(body, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
