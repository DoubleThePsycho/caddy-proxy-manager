// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { isFeatureConfigurable } from "@/ee/licensing/store";
import { getHistorySettings } from "@/ee/config-history/settings";
import { FEATURE, updateHistorySettings } from "@/ee/config-history/service";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "config_history:read");
    const [settings, configurable] = await Promise.all([getHistorySettings(), isFeatureConfigurable(FEATURE)]);
    return NextResponse.json({ ...settings, configurable });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * Turning recording on, or changing settings while it stays on, needs the
 * license (checked by updateHistorySettings); turning it off does not.
 */
export async function PUT(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "config_history:write");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiValidationError("Request body must be JSON");
    }
    const settings = await updateHistorySettings(body, userId);
    return NextResponse.json({ ...settings, configurable: await isFeatureConfigurable(FEATURE) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
