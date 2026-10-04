import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { addBlockedSource, getBlockedSourcesList } from "@/src/lib/models/access-lists";
import { assertProviderLevel } from "@/ee/multi-tenancy/scope";
import { readJsonBody } from "@/src/lib/access-list-http";

const PROVIDER_ONLY = "The Blocked sources list applies to every organisation; only provider-level users can use it";

/** The Blocked sources entries (deny rules), in order. */
export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "access_lists:read");
    assertProviderLevel(access, PROVIDER_ONLY);
    return NextResponse.json((await getBlockedSourcesList())?.rules ?? []);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * Blocks an address or network on every host, before anything else:
 * `{ "address": "198.51.100.19", "reason": "...", "expiresAt": "..." }`, or a
 * country, continent or AS number with `kind` and `value`. 201 with the new
 * entry; 200 with the existing one when it is already blocked (its reason and
 * expiry are updated when given).
 */
export async function POST(request: NextRequest) {
  try {
    const { access, userId } = await requireApiPermission(request, "access_lists:write");
    assertProviderLevel(access, PROVIDER_ONLY);
    const body = await readJsonBody(request);
    const { entry, created } = await addBlockedSource(body as Record<string, unknown>, userId);
    return NextResponse.json(entry, { status: created ? 201 : 200 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
