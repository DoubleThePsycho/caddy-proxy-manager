// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, requireApiPermission } from "@/src/lib/api-auth";
import { deleteSchedule, getSchedule, updateSchedule } from "@/ee/access-reviews/schedules";
import { NO_STORE, parseRouteId, readJsonBody } from "@/ee/access-reviews/http";

type Params = { params: Promise<{ id: string }> };

const NOT_FOUND = "Access review schedule not found";

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "access_reviews:read");
    return NextResponse.json(await getSchedule(parseRouteId((await params).id, NOT_FOUND)), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "access_reviews:write");
    const id = parseRouteId((await params).id, NOT_FOUND);
    return NextResponse.json(await updateSchedule(id, await readJsonBody(request), userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "access_reviews:write");
    await deleteSchedule(parseRouteId((await params).id, NOT_FOUND), userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
