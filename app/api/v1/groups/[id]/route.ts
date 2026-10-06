import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { getGroup, updateGroup, deleteGroup } from "@/src/lib/models/groups";
import { routeRowId } from "@/src/lib/row-ids";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "groups:read");
    const { id } = await params;
    const group = await getGroup(routeRowId(id, "Group not found"));
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
    const { userId } = await requireApiPermission(request, "groups:write");
    const { id } = await params;
    const body = await request.json();
    const group = await updateGroup(routeRowId(id), body, userId);
    return NextResponse.json(group);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "groups:write");
    const { id } = await params;
    await deleteGroup(routeRowId(id), userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
