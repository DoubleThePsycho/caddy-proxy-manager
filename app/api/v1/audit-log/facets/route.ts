import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { listAuditFacets } from "@/src/lib/models/audit";

/** The actors, actions and entity types that occur in the audit log, for the filters. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "audit_log:read");
    return NextResponse.json(await listAuditFacets(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
