import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { listCertificates, createCertificate } from "@/src/lib/models/certificates";
import { toCertificateApiResponse } from "@/src/lib/certificate-api";
import { assertCanCreateCertificate, certificateIdsInScope } from "@/src/lib/access-scope";

const PRIVATE_RESPONSE_INIT = { headers: { "Cache-Control": "no-store" } };

export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "certificates:read");
    const inScope = await certificateIdsInScope(access);
    const certs = (await listCertificates()).filter((cert) => inScope === null || inScope.has(cert.id));
    return NextResponse.json(certs.map(toCertificateApiResponse), PRIVATE_RESPONSE_INIT);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId, access } = await requireApiPermission(request, "certificates:write");
    assertCanCreateCertificate(access);
    const body = await request.json();
    const cert = await createCertificate(body, userId);
    return NextResponse.json(toCertificateApiResponse(cert), {
      status: 201,
      headers: PRIVATE_RESPONSE_INIT.headers,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
