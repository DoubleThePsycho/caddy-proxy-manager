// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { listRollouts, startPromotion } from "@/ee/fleet/rollouts";
import { NO_STORE, readJsonBody, readPageParam } from "@/ee/fleet/http";
import { parseRowId } from "@/src/lib/row-ids";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "fleet:read");
    const params = request.nextUrl.searchParams;
    const environment = params.get("environmentId");
    const environmentId = environment === null ? undefined : parseRowId(environment);
    if (environmentId === null) {
      throw new ApiValidationError("environmentId must be an environment id");
    }
    const limit = readPageParam(params.get("limit"), 25, 200);
    const offset = Math.max(Number.parseInt(params.get("offset") ?? "0", 10) || 0, 0);
    return NextResponse.json(
      await listRollouts({ environmentId, limit, offset }),
      { headers: NO_STORE }
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Start a promotion: `{ environmentId, canary? }`. */
export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "fleet:promote");
    return NextResponse.json(await startPromotion(await readJsonBody(request), userId), { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
