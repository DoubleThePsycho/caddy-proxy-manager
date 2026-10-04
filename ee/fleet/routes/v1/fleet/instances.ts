// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { listFleetInstances } from "@/ee/fleet/environments";
import { NO_STORE } from "@/ee/fleet/http";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "fleet:read");
    return NextResponse.json(await listFleetInstances(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
