// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { getHistorySettings } from "@/ee/config-history/settings";
import { updateHistorySettings } from "@/ee/config-history/service";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "config_history:read");
    return NextResponse.json(await getHistorySettings());
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "config_history:write");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiValidationError("Request body must be JSON");
    }
    return NextResponse.json(await updateHistorySettings(body, userId));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
