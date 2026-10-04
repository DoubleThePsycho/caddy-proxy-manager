import { NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse, getApiAccess } from "@/src/lib/api-auth";
import { deleteApiToken, getApiTokenSummary } from "@/src/lib/models/api-tokens";
import { logAuditEvent } from "@/src/lib/audit";
import { routeRowId } from "@/src/lib/row-ids";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // A token with scopes is refused: they do not cover the owner's tokens.
    const auth = await requireApiUser(request);
    const { id } = await params;
    const tokenId = routeRowId(id, "Token not found");
    const before = await getApiTokenSummary(tokenId);
    // Another user's token for administrators only, whatever a custom role holds.
    await deleteApiToken(tokenId, auth.userId, (await getApiAccess(auth)).isAdmin);
    if (before) {
      await logAuditEvent({
        userId: auth.userId,
        action: "api_token_deleted",
        entityType: "api_token",
        entityId: tokenId,
        summary: before.createdBy === auth.userId
          ? `Revoked API token "${before.name}"`
          : `Revoked API token "${before.name}" of user ${before.createdBy}`,
        data: { createdBy: before.createdBy },
      });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
