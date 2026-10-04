// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { previewPromotion } from "@/ee/fleet/rollouts";
import { NO_STORE } from "@/ee/fleet/http";
import { parseRowId } from "@/src/lib/row-ids";

/** `?environmentId=`: what promoting into that environment would roll out, and the diff. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "fleet:read");
    const raw = request.nextUrl.searchParams.get("environmentId") ?? "";
    const environmentId = parseRowId(raw);
    if (environmentId === null) throw new ApiValidationError("environmentId must be an environment id");
    return NextResponse.json(await previewPromotion(environmentId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
