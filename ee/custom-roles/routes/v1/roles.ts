// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { createRole, listRoles } from "@/ee/custom-roles/service";
import { assertMayUseCustomRoles } from "@/ee/multi-tenancy/users";

const NO_STORE = { "Cache-Control": "no-store" };

/** Custom roles. Readable without a license. */
export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "users:read");
    // Custom roles are the provider's (ee/multi-tenancy).
    assertMayUseCustomRoles(access);
    return NextResponse.json(await listRoles(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Creates a custom role (needs the custom_roles license feature). */
export async function POST(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "users:write");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiValidationError("Request body must be JSON");
    }
    return NextResponse.json(await createRole(access, body), { status: 201, headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
