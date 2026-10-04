import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { assertUnscopedCertificates } from "@/src/lib/access-scope";
import { listCaCertificates, createCaCertificate } from "@/src/lib/models/ca-certificates";

export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "certificates:read");
    assertUnscopedCertificates(access);
    const certs = await listCaCertificates();
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
    const cert = await createCaCertificate(body, userId);
    return NextResponse.json(cert, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
