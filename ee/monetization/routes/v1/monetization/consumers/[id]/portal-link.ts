// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { NO_STORE, parseRouteId } from "@/ee/monetization/http";
import { CONSUMER_NOT_FOUND, revokePortalLink, rotatePortalLink } from "@/ee/monetization/consumers";

type Params = { params: Promise<{ id: string }> };

/** Issues a new portal link; the previous one stops working. The link is in the response once. */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "monetization:write");
    return NextResponse.json(await rotatePortalLink(parseRouteId((await params).id, CONSUMER_NOT_FOUND), userId), {
      status: 201,
      headers: NO_STORE,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Turns the portal link off. */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "monetization:write");
    await revokePortalLink(parseRouteId((await params).id, CONSUMER_NOT_FOUND), userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
