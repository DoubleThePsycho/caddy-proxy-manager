import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { removeBlockedSource } from "@/src/lib/models/access-lists";
import { assertProviderLevel } from "@/ee/multi-tenancy/scope";
import { routeRowId } from "@/src/lib/row-ids";

/** Unblocks an entry of the Blocked sources list. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ entryId: string }> }
) {
  try {
    const { access, userId } = await requireApiPermission(request, "access_lists:write");
    assertProviderLevel(access, "The Blocked sources list applies to every organisation; only provider-level users can use it");
    const { entryId } = await params;
    await removeBlockedSource(routeRowId(entryId), userId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
