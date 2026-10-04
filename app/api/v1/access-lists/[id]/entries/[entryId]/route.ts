import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { removeAccessListEntry } from "@/src/lib/models/access-lists";
import { routeRowId } from "@/src/lib/row-ids";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; entryId: string }> }
) {
  try {
    const { userId } = await requireApiPermission(request, "access_lists:write");
    const { id, entryId } = await params;
    // The model answers 404 for a list of another organisation (ee/multi-tenancy)
    // and only removes an entry of this list.
    const list = await removeAccessListEntry(routeRowId(id), routeRowId(entryId), userId);
    return NextResponse.json(list);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
