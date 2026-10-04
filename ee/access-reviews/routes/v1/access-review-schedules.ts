// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, requireApiPermission } from "@/src/lib/api-auth";
import { createSchedule, listSchedules } from "@/ee/access-reviews/schedules";
import { NO_STORE, readJsonBody } from "@/ee/access-reviews/http";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "access_reviews:read");
    return NextResponse.json(await listSchedules(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "access_reviews:write");
    return NextResponse.json(await createSchedule(await readJsonBody(request), userId), { status: 201, headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
