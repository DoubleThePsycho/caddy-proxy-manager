import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { readJsonBody } from "@/src/lib/access-list-http";
import { addAccessListEntry } from "@/src/lib/models/access-lists";
import { routeRowId } from "@/src/lib/row-ids";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await requireApiPermission(request, "access_lists:write");
    const { id } = await params;
    const body = await readJsonBody(request);
    // The model answers 404 for a list of another organisation (ee/multi-tenancy).
    const list = await addAccessListEntry(routeRowId(id), body as { username: string; password: string }, userId);
    return NextResponse.json(list, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
