// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import {
  deleteOrganization,
  getOrganization,
  parseOrganizationId,
  updateOrganization,
} from "@/ee/multi-tenancy/service";
import { NO_STORE, readJsonBody } from "@/ee/multi-tenancy/http";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "organizations:read");
    return NextResponse.json(await getOrganization(parseOrganizationId((await params).id)), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Changes an organisation; disabling it ({"enabled": false} alone) never needs a license. */
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const { access } = await requireApiPermission(request, "organizations:write");
    const id = parseOrganizationId((await params).id);
    return NextResponse.json(await updateOrganization(access, id, await readJsonBody(request)), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Deletes an organisation that owns nothing any more (409 otherwise). Never needs a license. */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { access } = await requireApiPermission(request, "organizations:write");
    await deleteOrganization(access, parseOrganizationId((await params).id));
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
