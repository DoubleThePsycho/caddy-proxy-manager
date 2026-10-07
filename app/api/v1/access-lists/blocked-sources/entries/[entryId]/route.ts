import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { removeBlockedSource } from "@/src/lib/models/access-lists";
import { routeRowId } from "@/src/lib/row-ids";

/** Unblocks an entry of the Blocked sources list. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ entryId: string }> }
) {
  try {
    const { userId } = await requireApiPermission(request, "access_lists:write");
    const { entryId } = await params;
    await removeBlockedSource(routeRowId(entryId), userId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
