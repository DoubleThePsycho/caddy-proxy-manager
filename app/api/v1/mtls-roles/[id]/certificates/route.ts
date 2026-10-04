import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { assertUnscopedCertificates } from "@/src/lib/access-scope";
import { assignRoleToCertificate, getMtlsRole } from "@/src/lib/models/mtls-roles";
import { isRowId, routeRowId } from "@/src/lib/row-ids";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId, access } = await requireApiPermission(request, "certificates:write");
    assertUnscopedCertificates(access);
    const roleId = routeRowId((await params).id);
    const body = await request.json();
    if (!body.certificateId || typeof body.certificateId !== "number") {
      return NextResponse.json({ error: "certificateId is required" }, { status: 400 });
    }
    if (!isRowId(body.certificateId)) {
      return NextResponse.json({ error: "certificateId must be a certificate id" }, { status: 400 });
    }
    await assignRoleToCertificate(roleId, body.certificateId, userId);
    const role = await getMtlsRole(roleId);
    return NextResponse.json(role, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
