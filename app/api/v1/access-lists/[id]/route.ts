import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { readJsonBody } from "@/src/lib/access-list-http";
import { updateAccessList, deleteAccessList, type AccessListUpdate } from "@/src/lib/models/access-lists";
import { findAccessListInScope } from "@/src/lib/access-scope";
import { routeRowId } from "@/src/lib/row-ids";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { access } = await requireApiPermission(request, "access_lists:read");
    const { id } = await params;
    // 404 for a list of another organisation, as for a missing one.
    const list = await findAccessListInScope(access, routeRowId(id, "Not found"));
    if (!list) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(list);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await requireApiPermission(request, "access_lists:write");
    const { id } = await params;
    const body = await readJsonBody(request);
    // The model answers 404 for a list of another organisation (ee/multi-tenancy).
    const list = await updateAccessList(routeRowId(id), body as AccessListUpdate, userId);
    return NextResponse.json(list);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await requireApiPermission(request, "access_lists:write");
    const { id } = await params;
    // The model answers 404 for a list of another organisation (ee/multi-tenancy).
    await deleteAccessList(routeRowId(id), userId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
