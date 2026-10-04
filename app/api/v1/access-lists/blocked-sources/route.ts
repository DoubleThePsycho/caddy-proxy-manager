import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import {
  blockedSourcesPlaceholder,
  ensureBlockedSourcesList,
  getBlockedSourcesList,
  updateAccessList,
} from "@/src/lib/models/access-lists";
import { assertProviderLevel } from "@/ee/multi-tenancy/scope";
import { readJsonBody, readObjectBody } from "@/src/lib/access-list-http";

const PROVIDER_ONLY = "The Blocked sources list applies to every organisation; only provider-level users can use it";

/** The global Blocked sources list (id null before its first use). */
export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "access_lists:read");
    assertProviderLevel(access, PROVIDER_ONLY);
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
    const { access, userId } = await requireApiPermission(request, "access_lists:write");
    assertProviderLevel(access, PROVIDER_ONLY);
    const body = readObjectBody(await readJsonBody(request));
    const list = await ensureBlockedSourcesList(userId);
    return NextResponse.json(await updateAccessList(list.id, body, userId));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
