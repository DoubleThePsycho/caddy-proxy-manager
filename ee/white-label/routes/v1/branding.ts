// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { getBrandingView, resetBranding, updateBranding } from "@/ee/white-label/service";
import { parseBrandingInput } from "@/ee/white-label/validation";

const NO_STORE = { "Cache-Control": "no-store" };

/** White-label branding. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "branding:read");
    return NextResponse.json(await getBrandingView(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Partial update; null or an empty string restores a default. */
export async function PUT(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "branding:write");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiValidationError("Request body must be JSON");
    }
    return NextResponse.json(await updateBranding(parseBrandingInput(body), userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Resets everything, logos included, to the defaults. */
export async function DELETE(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "branding:write");
    return NextResponse.json(await resetBranding(userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
