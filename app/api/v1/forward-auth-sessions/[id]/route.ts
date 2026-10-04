import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { deleteForwardAuthSession, getForwardAuthSession } from "@/src/lib/models/forward-auth";
import { assertCanManageUserId } from "@/ee/custom-roles/service";
import { routeRowId } from "@/src/lib/row-ids";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { access } = await requireApiPermission(request, "users:write");
    const sessionId = routeRowId((await params).id, "Not found");
    if (!access.isAdmin) {
      // Only the sessions of users the caller may manage.
      const session = await getForwardAuthSession(sessionId);
      if (session) await assertCanManageUserId(access, session.userId);
    }
    await deleteForwardAuthSession(sessionId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
