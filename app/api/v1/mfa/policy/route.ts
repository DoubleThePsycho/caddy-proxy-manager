import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { getMfaPolicyView, parseMfaPolicyInput, updateMfaPolicy } from "@/src/lib/mfa";

const NO_STORE = { "Cache-Control": "no-store" };

/** The MFA policy for dashboard sign-in and which accounts have not enrolled yet. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "mfa_policy:read");
    return NextResponse.json(await getMfaPolicyView(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "mfa_policy:write");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiValidationError("Request body must be JSON");
    }
    return NextResponse.json(await updateMfaPolicy(parseMfaPolicyInput(body), userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
