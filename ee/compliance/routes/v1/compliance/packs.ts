// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { NO_STORE, readPageParam } from "@/ee/compliance/http";
import { listEvidencePacks } from "@/ee/compliance/schedules";

/** The newest evidence packs (the reports of one scheduled run), newest first; ?limit= (at most 50). */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "compliance:read");
    const limit = readPageParam(request.nextUrl.searchParams.get("limit"), 12, 50);
    return NextResponse.json({ packs: await listEvidencePacks(limit) }, { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
