import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiClientError } from "@/src/lib/api-errors";
import { getUserById } from "@/src/lib/models/user";
import { signOutSession } from "@/src/lib/models/sessions";
import { assertCanManageUserId } from "@/ee/custom-roles/service";
import { routeRowId } from "@/src/lib/row-ids";

function parseId(id: string, what: string): number {
  return routeRowId(id, `${what} not found`);
}

/** Signs out one session of a user (users:write). Recorded as session_revoked. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; sessionId: string }> }
) {
  try {
    const { access, userId } = await requireApiPermission(request, "users:write");
    const { id, sessionId: rawSessionId } = await params;
    const targetId = parseId(id, "User");
    const sessionId = parseId(rawSessionId, "Session");
    if (!(await getUserById(targetId))) throw new ApiClientError("User not found", 404);
    await assertCanManageUserId(access, targetId);
    if (!(await signOutSession({ actorUserId: userId, userId: targetId }, sessionId))) {
      throw new ApiClientError("Session not found", 404);
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
