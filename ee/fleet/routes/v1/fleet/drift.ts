// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { listFleetInstances } from "@/ee/fleet/environments";
import { runDriftChecks } from "@/ee/fleet/drift";
import { NO_STORE } from "@/ee/fleet/http";

/** The drift status of every instance, as of the last check. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "fleet:read");
    return NextResponse.json(await listFleetInstances(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Check every enabled instance now. */
export async function POST(request: NextRequest) {
  try {
    await requireApiPermission(request, "fleet:write");
    return NextResponse.json(await runDriftChecks(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
