// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { getDigestSettingsView, saveDigestSettings } from "@/ee/ai/digest-settings";
import { NO_STORE, readJsonBody } from "@/ee/alerting/http";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "ai:read");
    return NextResponse.json(await getDigestSettingsView(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Needs a license with the AI analyst, except {"enabled": false} and/or {"ai": false}. */
export async function PUT(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "ai:write");
    return NextResponse.json(await saveDigestSettings(await readJsonBody(request), userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
