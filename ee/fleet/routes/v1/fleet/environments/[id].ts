// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ENVIRONMENT_NOT_FOUND, deleteEnvironment, getEnvironment, updateEnvironment } from "@/ee/fleet/environments";
import { parseRouteId, readJsonBody } from "@/ee/fleet/http";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "fleet:read");
    return NextResponse.json(await getEnvironment(parseRouteId((await params).id, ENVIRONMENT_NOT_FOUND)));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Change an environment; turning promotion-only off also needs fleet:promote when it has instances. */
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const { userId, access } = await requireApiPermission(request, "fleet:write");
    const id = parseRouteId((await params).id, ENVIRONMENT_NOT_FOUND);
    return NextResponse.json(await updateEnvironment(id, await readJsonBody(request), { userId, access }));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { userId, access } = await requireApiPermission(request, "fleet:write");
    await deleteEnvironment(parseRouteId((await params).id, ENVIRONMENT_NOT_FOUND), { userId, access });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
