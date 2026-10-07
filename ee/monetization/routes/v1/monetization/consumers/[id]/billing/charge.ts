// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission } from "@/src/lib/api-auth";
import { NO_STORE, parseRouteId } from "@/ee/monetization/http";
import { CONSUMER_NOT_FOUND } from "@/ee/monetization/consumers";
import { chargeNow } from "@/ee/monetization/postpaid";
import { monetizationErrorResponse } from "@/ee/monetization/responses";

type Params = { params: Promise<{ id: string }> };

/** Postpaid: charges the saved card for the open amount now. */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "monetization:write");
    const id = parseRouteId((await params).id, CONSUMER_NOT_FOUND);
    return NextResponse.json(await chargeNow(id, userId), { headers: NO_STORE });
  } catch (error) {
    return monetizationErrorResponse(error);
  }
}
