import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { removeGroupMember } from "@/src/lib/models/groups";
import { getGroupInScope } from "@/src/lib/access-scope";
import { routeRowId } from "@/src/lib/row-ids";

type Params = { params: Promise<{ id: string; userId: string }> };

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { userId: actorUserId, access } = await requireApiPermission(request, "groups:write");
    const { id, userId } = await params;
    const existing = await getGroupInScope(access, routeRowId(id));
    const group = await removeGroupMember(existing.id, routeRowId(userId), actorUserId);
    return NextResponse.json(group);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
