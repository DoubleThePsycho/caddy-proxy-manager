// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { checkLicenseServerNow } from "@/ee/licensing/auto-update";

/** Ask the license server for a renewed key now, outside the daily slot. */
export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "license:write");
    return NextResponse.json(await checkLicenseServerNow(userId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
