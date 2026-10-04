import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { assertUnscopedCertificates } from "@/src/lib/access-scope";
import { getIssuedClientCertificate, revokeIssuedClientCertificate } from "@/src/lib/models/issued-client-certificates";
import { routeRowId } from "@/src/lib/row-ids";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { access } = await requireApiPermission(request, "certificates:read");
    assertUnscopedCertificates(access);
    const { id } = await params;
    const cert = await getIssuedClientCertificate(routeRowId(id, "Not found"));
    if (!cert) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(cert);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId, access } = await requireApiPermission(request, "certificates:write");
    assertUnscopedCertificates(access);
    const { id } = await params;
    const cert = await revokeIssuedClientCertificate(routeRowId(id), userId);
    return NextResponse.json(cert);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
