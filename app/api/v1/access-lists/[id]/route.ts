import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { readJsonBody } from "@/src/lib/access-list-http";
import { getAccessList, updateAccessList, deleteAccessList, type AccessListUpdate } from "@/src/lib/models/access-lists";
import { routeRowId } from "@/src/lib/row-ids";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireApiPermission(request, "access_lists:read");
    const { id } = await params;
    const list = await getAccessList(routeRowId(id, "Not found"));
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
    await deleteAccessList(routeRowId(id), userId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
