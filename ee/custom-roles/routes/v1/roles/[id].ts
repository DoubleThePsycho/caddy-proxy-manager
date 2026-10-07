// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { deleteRole, getRole, updateRole } from "@/ee/custom-roles/service";
import { routeRowId } from "@/src/lib/row-ids";

type Params = { params: Promise<{ id: string }> };

const NO_STORE = { "Cache-Control": "no-store" };

function parseRoleId(id: string): number {
  return routeRowId(id, "Role not found");
}

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "users:read");
    return NextResponse.json(await getRole(parseRoleId((await params).id)), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Changes a custom role. */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { access } = await requireApiPermission(request, "users:write");
    const roleId = parseRoleId((await params).id);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiValidationError("Request body must be JSON");
    }
    return NextResponse.json(await updateRole(access, roleId, body), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Deletes a custom role; its users fall back to the built-in viewer role. */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { access } = await requireApiPermission(request, "users:write");
    const result = await deleteRole(access, parseRoleId((await params).id));
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
