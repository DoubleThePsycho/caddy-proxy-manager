// SPDX-License-Identifier: Elastic-2.0
import { NextRequest } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { exportAuditLog } from "@/ee/audit/export";

export async function GET(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "audit_log:read");
    const { body, filename, contentType } = await exportAuditLog(request.nextUrl.searchParams, userId);
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
