// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, requireApiPermission } from "@/src/lib/api-auth";
import { releaseUser } from "@/ee/scim/service";
import { parseRouteId } from "@/ee/scim/rest";

type Params = { params: Promise<{ id: string }> };

/** Stops SCIM managing the user; the account is not changed. */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { access } = await requireApiPermission(request, "scim:write");
    await releaseUser(access, parseRouteId((await params).id, "SCIM does not manage this user"));
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
