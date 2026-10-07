// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { clearAiSettings, getAiSettingsView, saveAiSettings } from "@/ee/ai/settings";
import { NO_STORE, readJsonBody } from "@/ee/alerting/http";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "ai:read");
    return NextResponse.json(await getAiSettingsView(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "ai:write");
    return NextResponse.json(await saveAiSettings(await readJsonBody(request), userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Removes the provider and its key. */
export async function DELETE(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "ai:write");
    await clearAiSettings(userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
