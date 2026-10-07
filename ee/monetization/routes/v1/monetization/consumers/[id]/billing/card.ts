// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { parseRouteId } from "@/ee/monetization/http";
import { CONSUMER_NOT_FOUND } from "@/ee/monetization/consumers";
import { forgetCard } from "@/ee/monetization/postpaid";

type Params = { params: Promise<{ id: string }> };

/** Removes a postpaid consumer's saved card (and detaches it in Stripe). */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "monetization:write");
    const id = parseRouteId((await params).id, CONSUMER_NOT_FOUND);
    await forgetCard(id, userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
