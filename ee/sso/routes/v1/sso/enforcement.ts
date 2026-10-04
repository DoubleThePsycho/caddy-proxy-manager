// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import {
  getSsoEnforcementView,
  parseSsoEnforcementInput,
  updateSsoEnforcement,
} from "@/ee/sso/enforcement";

const NO_STORE = { "Cache-Control": "no-store" };

/** Enforced SSO for dashboard sign-in. Readable without a license. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "sso:read");
    return NextResponse.json(await getSsoEnforcementView(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "sso:write");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiValidationError("Request body must be JSON");
    }
    const view = await updateSsoEnforcement(parseSsoEnforcementInput(body), userId);
    return NextResponse.json(view, { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
