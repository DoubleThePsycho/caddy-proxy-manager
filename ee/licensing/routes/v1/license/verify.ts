// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { checkLicenseKey } from "@/ee/licensing/store";
import { readLicenseKeyBody } from "@/ee/licensing/http";
import { toLicenseKeyCheck } from "@/ee/licensing/view";

/**
 * Checks a license key on this machine and says what it would grant, without
 * storing it or changing anything (the verify step before installing). Same
 * permission as installing. The answer never contains the key.
 */
export async function POST(request: NextRequest) {
  try {
    await requireApiPermission(request, "license:write");
    const key = await readLicenseKeyBody(request);
    const { state, installable, error } = await checkLicenseKey(key);
    return NextResponse.json(toLicenseKeyCheck(state, installable, error), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
