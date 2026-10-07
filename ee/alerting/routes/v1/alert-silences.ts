// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { createAlertSilence, listAlertSilences } from "@/ee/alerting/silences";
import { NO_STORE, readJsonBody } from "@/ee/alerting/http";

/** The mutes and dismissals in effect. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "alerts:read");
    return NextResponse.json(await listAlertSilences(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Dismisses an alert or mutes a rule. */
export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "alerts:write");
    return NextResponse.json(await createAlertSilence(await readJsonBody(request), userId), { status: 201, headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
