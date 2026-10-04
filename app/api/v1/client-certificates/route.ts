import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { assertUnscopedCertificates } from "@/src/lib/access-scope";
import { listIssuedClientCertificates, createIssuedClientCertificate } from "@/src/lib/models/issued-client-certificates";

export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "certificates:read");
    assertUnscopedCertificates(access);
    const certs = await listIssuedClientCertificates();
    return NextResponse.json(certs);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId, access } = await requireApiPermission(request, "certificates:write");
    assertUnscopedCertificates(access);
    const body = await request.json();
    const cert = await createIssuedClientCertificate(body, userId);
    return NextResponse.json(cert, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
