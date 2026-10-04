import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { getCertificate, updateCertificate, deleteCertificate } from "@/src/lib/models/certificates";
import { toCertificateApiResponse } from "@/src/lib/certificate-api";
import { assertCertificateWritable, certificateIdsInScope } from "@/src/lib/access-scope";
import { routeRowId } from "@/src/lib/row-ids";

const PRIVATE_RESPONSE_INIT = { headers: { "Cache-Control": "no-store" } };

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { access } = await requireApiPermission(request, "certificates:read");
    const { id } = await params;
    const inScope = await certificateIdsInScope(access);
    // 404 for a certificate outside the caller's tag scope, as for a missing one.
    const certificateId = routeRowId(id, "Not found");
    const cert = inScope === null || inScope.has(certificateId) ? await getCertificate(certificateId) : null;
    if (!cert) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(toCertificateApiResponse(cert), PRIVATE_RESPONSE_INIT);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId, access } = await requireApiPermission(request, "certificates:write");
    const { id } = await params;
    const certificateId = routeRowId(id);
    await assertCertificateWritable(access, certificateId);
    const body = await request.json();
    const cert = await updateCertificate(certificateId, body, userId);
    return NextResponse.json(toCertificateApiResponse(cert), PRIVATE_RESPONSE_INIT);
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
    const { id } = await params;
    const certificateId = routeRowId(id);
    await assertCertificateWritable(access, certificateId);
    await deleteCertificate(certificateId, userId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
