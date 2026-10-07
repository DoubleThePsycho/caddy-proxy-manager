// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { checkLicenseNow } from "@/ee/licensing/online-check";

/** Confirm the installed online key with the license server now, outside the daily check. */
export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "license:write");
    return NextResponse.json(await checkLicenseNow(userId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
