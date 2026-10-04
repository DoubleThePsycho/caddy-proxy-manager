// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { REVISION_NOT_FOUND, getRevisionDiff } from "@/ee/fleet/revisions";
import { parseRouteId } from "@/ee/fleet/http";

type Params = { params: Promise<{ id: string }> };

/** `?against=previous` (default), `current` or a revision id. Secrets are never returned. */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "fleet:read");
    const id = parseRouteId((await params).id, REVISION_NOT_FOUND);
    return NextResponse.json(await getRevisionDiff(id, request.nextUrl.searchParams.get("against")));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
