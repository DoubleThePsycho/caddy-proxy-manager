// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ROLLOUT_NOT_FOUND, getRollout } from "@/ee/fleet/rollouts";
import { NO_STORE, parseRouteId } from "@/ee/fleet/http";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "fleet:read");
    return NextResponse.json(await getRollout(parseRouteId((await params).id, ROLLOUT_NOT_FOUND)), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
