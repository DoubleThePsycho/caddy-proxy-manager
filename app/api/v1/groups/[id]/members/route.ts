import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { addGroupMember, getGroup } from "@/src/lib/models/groups";
import { parseRowId, routeRowId } from "@/src/lib/row-ids";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { userId: actorUserId } = await requireApiPermission(request, "groups:write");
    const { id } = await params;
    const existing = await getGroup(routeRowId(id));
    if (!existing) throw new Error("Group not found");
    const body = await request.json();
    if (!body.userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }
    const memberId = parseRowId(body.userId);
    if (memberId === null) {
      return NextResponse.json({ error: "userId must be a user id" }, { status: 400 });
    }
    const group = await addGroupMember(existing.id, memberId, actorUserId);
    return NextResponse.json(group, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
