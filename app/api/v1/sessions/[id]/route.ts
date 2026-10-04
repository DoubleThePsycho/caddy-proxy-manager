import { NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api-auth";
import { signOutSession } from "@/src/lib/models/sessions";
import { parseRowId } from "@/src/lib/row-ids";

/** DELETE /api/v1/sessions/[id] — sign out one of the caller's own sessions. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await requireApiUser(request);
    const { id } = await params;
    const sessionId = parseRowId(id);
    if (sessionId === null) {
      return NextResponse.json({ error: "Invalid session id" }, { status: 400 });
    }
    const revoked = await signOutSession({ actorUserId: userId, userId }, sessionId);
    if (!revoked) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
