// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, requireApiPermission } from "@/src/lib/api-auth";
import { getScimSettingsView, updateScimSettings } from "@/ee/scim/service";
import { NO_STORE, readJsonBody } from "@/ee/scim/rest";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "scim:read");
    return NextResponse.json(await getScimSettingsView(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "scim:write");
    return NextResponse.json(await updateScimSettings(await readJsonBody(request), userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
