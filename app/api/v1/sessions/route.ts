import { NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api-auth";
import { getCurrentSessionId } from "@/src/lib/auth";
import { describeUserSessions, signOutSessions } from "@/src/lib/models/sessions";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/v1/sessions — the caller's active dashboard sessions, with device,
 * approximate place and times. A token with scopes is refused.
 */
export async function GET(request: NextRequest) {
  try {
    const { userId } = await requireApiUser(request);
    const currentId = await getCurrentSessionId(request);
    return NextResponse.json(await describeUserSessions(userId, currentId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** DELETE /api/v1/sessions — sign out all of the caller's OTHER sessions. */
export async function DELETE(request: NextRequest) {
  try {
    const { userId } = await requireApiUser(request);
    const currentId = await getCurrentSessionId(request);
    const revoked = await signOutSessions({ actorUserId: userId, userId }, currentId);
    return NextResponse.json({ revoked });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
