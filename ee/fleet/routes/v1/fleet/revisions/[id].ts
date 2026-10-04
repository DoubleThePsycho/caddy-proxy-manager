// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { REVISION_NOT_FOUND, requireRevision } from "@/ee/fleet/revisions";
import { parseRouteId } from "@/ee/fleet/http";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "fleet:read");
    return NextResponse.json(await requireRevision(parseRouteId((await params).id, REVISION_NOT_FOUND)));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
