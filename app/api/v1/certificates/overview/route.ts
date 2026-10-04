import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { buildCertificateOverview } from "@/src/lib/certificate-overview";
import { readOrganizationFilterParam } from "@/ee/multi-tenancy/scope";

/**
 * GET /api/v1/certificates/overview — every certificate the caller may see
 * (ACME, imported and managed entries) with how it is obtained, its expiry,
 * its renewal state and the hosts that use it. No PEM or key material.
 */
export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "certificates:read");
    const organizationId = readOrganizationFilterParam(access, request.nextUrl.searchParams.get("organizationId"));
    const overview = await buildCertificateOverview(access, organizationId);
    return NextResponse.json(overview, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
