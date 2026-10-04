// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { NO_STORE, parseRouteId, readJsonBody } from "@/ee/compliance/http";
import { deleteReportSchedule, getReportSchedule, SCHEDULE_NOT_FOUND, updateReportSchedule } from "@/ee/compliance/schedules";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "compliance:read");
    return NextResponse.json(await getReportSchedule(parseRouteId((await params).id, SCHEDULE_NOT_FOUND)), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Partial update; {"enabled": false} needs no license, any other change does. */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "compliance:write");
    const id = parseRouteId((await params).id, SCHEDULE_NOT_FOUND);
    return NextResponse.json(await updateReportSchedule(id, await readJsonBody(request), userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Never needs a license; the reports it generated are kept. */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "compliance:write");
    await deleteReportSchedule(parseRouteId((await params).id, SCHEDULE_NOT_FOUND), userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
