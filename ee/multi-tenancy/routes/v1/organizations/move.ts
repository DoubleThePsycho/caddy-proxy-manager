// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { moveResources, readMoveRequest } from "@/ee/multi-tenancy/service";
import { NO_STORE, readJsonBody } from "@/ee/multi-tenancy/http";

/**
 * Moves proxy hosts, certificates, access lists, groups and users to an
 * organisation, or to the provider level with "organizationId": null.
 * Moving into an organisation needs the license; moving out never does.
 */
export async function POST(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "organizations:write");
    const result = await moveResources(access, readMoveRequest(await readJsonBody(request)));
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
