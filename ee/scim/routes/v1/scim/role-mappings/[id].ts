// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, requireApiPermission } from "@/src/lib/api-auth";
import { deleteRoleMapping, updateRoleMapping } from "@/ee/scim/service";
import { NO_STORE, parseRouteId, readJsonBody } from "@/ee/scim/rest";

type Params = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { access } = await requireApiPermission(request, "scim:write");
    const id = parseRouteId((await params).id, "Role mapping not found");
    return NextResponse.json(await updateRoleMapping(access, id, await readJsonBody(request)), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { access } = await requireApiPermission(request, "scim:write");
    await deleteRoleMapping(access, parseRouteId((await params).id, "Role mapping not found"));
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
