import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { updateGroup, deleteGroup } from "@/src/lib/models/groups";
import { findGroupInScope, getGroupInScope } from "@/src/lib/access-scope";
import { routeRowId } from "@/src/lib/row-ids";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { access } = await requireApiPermission(request, "groups:read");
    const { id } = await params;
    // 404 for a group of another organisation, as for a missing one.
    const group = await findGroupInScope(access, routeRowId(id, "Group not found"));
    if (!group) {
      return NextResponse.json({ error: "Group not found" }, { status: 404 });
    }
    return NextResponse.json(group);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const { userId, access } = await requireApiPermission(request, "groups:write");
    const { id } = await params;
    const existing = await getGroupInScope(access, routeRowId(id));
    const body = await request.json();
    const group = await updateGroup(existing.id, body, userId);
    return NextResponse.json(group);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { userId, access } = await requireApiPermission(request, "groups:write");
    const { id } = await params;
    const existing = await getGroupInScope(access, routeRowId(id));
    await deleteGroup(existing.id, userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
