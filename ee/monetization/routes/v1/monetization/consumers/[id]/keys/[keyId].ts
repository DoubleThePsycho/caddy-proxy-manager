// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { parseRouteId } from "@/ee/monetization/http";
import { CONSUMER_NOT_FOUND, KEY_NOT_FOUND, revokeConsumerKey } from "@/ee/monetization/consumers";

type Params = { params: Promise<{ id: string; keyId: string }> };

/** Revokes the key (it stops working at once). Never needs a license. */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "monetization:write");
    const { id, keyId } = await params;
    await revokeConsumerKey(parseRouteId(id, CONSUMER_NOT_FOUND), parseRouteId(keyId, KEY_NOT_FOUND), userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
