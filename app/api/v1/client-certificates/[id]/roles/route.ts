import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { assertUnscopedCertificates } from "@/src/lib/access-scope";
import { getCertificateRoles } from "@/src/lib/models/mtls-roles";
import { routeRowId } from "@/src/lib/row-ids";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { access } = await requireApiPermission(request, "certificates:read");
    assertUnscopedCertificates(access);
    const { id } = await params;
    const roles = await getCertificateRoles(routeRowId(id));
    return NextResponse.json(roles);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
