// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, requireApiPermission } from "@/src/lib/api-auth";
import { adoptGroup, listManagedGroups } from "@/ee/scim/service";
import { NO_STORE, readJsonBody } from "@/ee/scim/rest";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "scim:read");
    return NextResponse.json(await listManagedGroups(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Lets SCIM manage an existing forward-auth group: {groupId, externalId?}. */
export async function POST(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "scim:write");
    return NextResponse.json(await adoptGroup(access, await readJsonBody(request)), { status: 201, headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
