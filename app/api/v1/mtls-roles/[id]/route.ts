import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { assertUnscopedCertificates } from "@/src/lib/access-scope";
import { getMtlsRole, updateMtlsRole, deleteMtlsRole } from "@/src/lib/models/mtls-roles";
import { routeRowId } from "@/src/lib/row-ids";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { access } = await requireApiPermission(request, "certificates:read");
    assertUnscopedCertificates(access);
    const { id } = await params;
    const role = await getMtlsRole(routeRowId(id, "Not found"));
    if (!role) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(role);
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
    assertUnscopedCertificates(access);
    const { id } = await params;
    const body = await request.json();
    const role = await updateMtlsRole(routeRowId(id), body, userId);
    return NextResponse.json(role);
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
    await deleteMtlsRole(routeRowId(id), userId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
