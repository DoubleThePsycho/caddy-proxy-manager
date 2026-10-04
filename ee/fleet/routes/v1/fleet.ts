// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { getFleetOverview } from "@/ee/fleet/overview";
import { NO_STORE } from "@/ee/fleet/http";

/** Environments, instances with their revision and drift, recent revisions and rollouts. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "fleet:read");
    return NextResponse.json(await getFleetOverview(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
