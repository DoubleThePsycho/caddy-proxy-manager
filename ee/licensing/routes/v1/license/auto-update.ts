// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { getLicenseAutoUpdateView, parseLicenseAutoUpdateInput, setLicenseAutoUpdate } from "@/ee/licensing/auto-update";

const NO_STORE = { "Cache-Control": "no-store" };

/** The automatic license update setting and its last results; never the refresh token. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "license:read");
    return NextResponse.json(await getLicenseAutoUpdateView(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Turn automatic updates on (with the license's refresh token) or off (the token is deleted). */
export async function PUT(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "license:write");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiValidationError("Request body must be JSON");
    }
    const input = parseLicenseAutoUpdateInput(body);
    return NextResponse.json(await setLicenseAutoUpdate(input, userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
