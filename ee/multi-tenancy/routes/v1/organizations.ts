// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { createOrganization, listOrganizations } from "@/ee/multi-tenancy/service";
import { NO_STORE, readJsonBody } from "@/ee/multi-tenancy/http";

/** Client organisations with what each owns. Readable without a license. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "organizations:read");
    return NextResponse.json(await listOrganizations(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Creates an organisation (needs the multi_tenancy license feature). */
export async function POST(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "organizations:write");
    const organization = await createOrganization(access, await readJsonBody(request));
    return NextResponse.json(organization, { status: 201, headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
