// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { listRevisions } from "@/ee/fleet/revisions";
import { readPageParam } from "@/ee/fleet/http";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "fleet:read");
    const params = request.nextUrl.searchParams;
    const limit = readPageParam(params.get("limit"), 50, 200);
    const offset = Math.max(Number.parseInt(params.get("offset") ?? "0", 10) || 0, 0);
    return NextResponse.json(await listRevisions({ limit, offset }));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
