import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { getCurrentSessionId } from "@/src/lib/auth";
import { ApiClientError } from "@/src/lib/api-errors";
import { findUserInScope } from "@/src/lib/access-scope";
import { describeUserSessions, signOutSessions } from "@/src/lib/models/sessions";
import { assertCanManageUserId } from "@/ee/custom-roles/service";
import { routeRowId } from "@/src/lib/row-ids";

const NO_STORE = { "Cache-Control": "no-store" };

function parseUserId(id: string): number {
  return routeRowId(id, "User not found");
}

/** A user's active dashboard sessions, with device, approximate place and times (users:read). */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { access } = await requireApiPermission(request, "users:read");
    const targetId = parseUserId((await params).id);
    // A user of another organisation (ee/multi-tenancy) is not found, as a missing one.
    if (!(await findUserInScope(access, targetId))) throw new ApiClientError("User not found", 404);
    const currentId = await getCurrentSessionId(request);
    return NextResponse.json(await describeUserSessions(targetId, currentId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * Signs out every session of a user (users:write). The caller's own current
 * session is kept when they name themselves. Recorded as sessions_revoked.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { access, userId } = await requireApiPermission(request, "users:write");
    const targetId = parseUserId((await params).id);
    if (!(await findUserInScope(access, targetId))) throw new ApiClientError("User not found", 404);
    // Only users whose access the caller holds themselves (ee/custom-roles).
    await assertCanManageUserId(access, targetId);
    const keep = targetId === userId ? await getCurrentSessionId(request) : null;
    const revoked = await signOutSessions({ actorUserId: userId, userId: targetId }, keep);
    return NextResponse.json({ revoked });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
