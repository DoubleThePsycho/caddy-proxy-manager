import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { getGroupsOverview } from "@/src/lib/users-overview";
import { readOrganizationFilterParam } from "@/ee/multi-tenancy/scope";

/**
 * GET /api/v1/groups/overview — every forward-auth group the caller may
 * list, with its members, whether SCIM manages it, its SCIM role mappings
 * (scim:read) and the proxy hosts it lets its members reach (proxy_hosts:read).
 */
export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "groups:read");
    const organizationId = readOrganizationFilterParam(access, request.nextUrl.searchParams.get("organizationId"));
    return NextResponse.json(await getGroupsOverview(access, organizationId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
