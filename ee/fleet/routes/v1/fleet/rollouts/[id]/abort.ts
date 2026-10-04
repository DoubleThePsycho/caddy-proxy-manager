// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ROLLOUT_NOT_FOUND, abortRollout } from "@/ee/fleet/rollouts";
import { parseRouteId } from "@/ee/fleet/http";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "fleet:promote");
    return NextResponse.json(await abortRollout(parseRouteId((await params).id, ROLLOUT_NOT_FOUND), userId));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
