// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { NO_STORE, readJsonBody } from "@/ee/compliance/http";
import { createReportSchedule, listReportSchedules } from "@/ee/compliance/schedules";

/** Report schedules with their next run and the reports of their last run. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "compliance:read");
    return NextResponse.json({ schedules: await listReportSchedules() }, { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** {name, frequency, weekday?, dayOfMonth?, time?, timeZone?, reportTypes?, channelIds?, enabled?}; license. */
export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "compliance:write");
    const schedule = await createReportSchedule(await readJsonBody(request), userId);
    return NextResponse.json(schedule, { status: 201, headers: { ...NO_STORE, Location: `/api/v1/compliance/schedules/${schedule.id}` } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
