// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, requireApiPermission } from "@/src/lib/api-auth";
import { releaseGroup } from "@/ee/scim/service";
import { parseRouteId } from "@/ee/scim/rest";

type Params = { params: Promise<{ id: string }> };

/** Stops SCIM managing the group; the group and its members stay. */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { access } = await requireApiPermission(request, "scim:write");
    await releaseGroup(access, parseRouteId((await params).id, "SCIM does not manage this group"));
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
