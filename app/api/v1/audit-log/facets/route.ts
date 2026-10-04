import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { listAuditFacets } from "@/src/lib/models/audit";
import { readOrganizationFilterParam } from "@/ee/multi-tenancy/scope";

/** The actors, actions and entity types that occur in the audit log, for the filters. */
export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "audit_log:read");
    const organizationId = readOrganizationFilterParam(access, request.nextUrl.searchParams.get("organizationId"));
    return NextResponse.json(await listAuditFacets(organizationId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
