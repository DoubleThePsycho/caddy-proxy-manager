import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { assertUnscopedCertificates } from "@/src/lib/access-scope";
import { removeRoleFromCertificate } from "@/src/lib/models/mtls-roles";
import { routeRowId } from "@/src/lib/row-ids";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; certId: string }> }
) {
  try {
    const { userId, access } = await requireApiPermission(request, "certificates:write");
    assertUnscopedCertificates(access);
    const { id, certId } = await params;
    await removeRoleFromCertificate(routeRowId(id), routeRowId(certId), userId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
