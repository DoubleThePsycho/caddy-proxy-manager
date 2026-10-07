// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { deactivateLicenseHere, LicenseReleaseError } from "@/ee/licensing/online-check";

/**
 * Release the installed online key on the license server and remove it from
 * this install, so another install can use the license. Body: optional
 * {"force": true} to remove the key even when the license server cannot be
 * reached. 502 when it cannot be reached and force is not set.
 */
export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "license:write");
    let force = false;
    const text = await request.text();
    if (text.trim().length > 0) {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new ApiValidationError("Request body must be JSON");
      }
      const value = (body as { force?: unknown } | null)?.force;
      if (typeof body !== "object" || body === null || Array.isArray(body) || (value !== undefined && typeof value !== "boolean")) {
        throw new ApiValidationError('Body must be empty or {"force": true | false}');
      }
      force = value === true;
    }
    return NextResponse.json(await deactivateLicenseHere(userId, { force }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof LicenseReleaseError) {
      return NextResponse.json({ error: error.message }, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
    return apiErrorResponse(error);
  }
}
