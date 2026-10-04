// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { describePermissionCatalogue } from "@/ee/custom-roles/catalogue";

/** The permission catalogue custom roles are made from. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "users:read");
    return NextResponse.json(describePermissionCatalogue());
  } catch (error) {
    return apiErrorResponse(error);
  }
}
