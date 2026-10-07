// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { NO_STORE, parseRouteId } from "@/ee/compliance/http";
import { runReportScheduleNow, SCHEDULE_NOT_FOUND } from "@/ee/compliance/schedules";

type Params = { params: Promise<{ id: string }> };

/** Runs the schedule now for the week or month that has ended. */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "compliance:write");
    const result = await runReportScheduleNow(parseRouteId((await params).id, SCHEDULE_NOT_FOUND), userId);
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
