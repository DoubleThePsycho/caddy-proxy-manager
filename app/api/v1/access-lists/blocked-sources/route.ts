import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import {
  blockedSourcesPlaceholder,
  ensureBlockedSourcesList,
  getBlockedSourcesList,
  updateAccessList,
} from "@/src/lib/models/access-lists";
import { readJsonBody, readObjectBody } from "@/src/lib/access-list-http";

/** The global Blocked sources list (id null before its first use). */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "access_lists:read");
    return NextResponse.json((await getBlockedSourcesList()) ?? blockedSourcesPlaceholder());
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * Changes the list's description, deny response and fail-closed setting, and
 * with `rules` replaces every entry. It only denies and keeps its name.
 */
export async function PUT(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "access_lists:write");
    const body = readObjectBody(await readJsonBody(request));
    const list = await ensureBlockedSourcesList();
    return NextResponse.json(await updateAccessList(list.id, body, userId));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
