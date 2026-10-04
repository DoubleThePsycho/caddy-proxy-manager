// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { NO_STORE, parseRouteId, readJsonBody } from "@/ee/monetization/http";
import { deletePlan, getPlan, PLAN_NOT_FOUND, updatePlan } from "@/ee/monetization/plans";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "monetization:read");
    return NextResponse.json(await getPlan(parseRouteId((await params).id, PLAN_NOT_FOUND)), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "monetization:write");
    const id = parseRouteId((await params).id, PLAN_NOT_FOUND);
    return NextResponse.json(await updatePlan(id, await readJsonBody(request), userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "monetization:write");
    await deletePlan(parseRouteId((await params).id, PLAN_NOT_FOUND), userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
