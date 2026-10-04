// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { listFiringAlerts } from "@/ee/alerting/events";
import { NO_STORE } from "@/ee/alerting/http";

/** Every alert firing now, with the event that started it. Never needs a license. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "alerts:read");
    return NextResponse.json({ alerts: await listFiringAlerts() }, { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
