// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { NO_STORE, readPageParam } from "@/ee/monetization/http";
import { listPayments } from "@/ee/monetization/stripe-payments";
import { parseRowId } from "@/src/lib/row-ids";

/** Stripe payments of consumers (top-ups, postpaid charges, open amounts), newest first. ?consumerId=&limit= */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "monetization:read");
    const search = request.nextUrl.searchParams;
    const consumerParam = search.get("consumerId");
    const consumerId = consumerParam ? parseRowId(consumerParam) : null;
    if (consumerParam && consumerId === null) throw new ApiValidationError("consumerId must be a consumer id");
    return NextResponse.json(await listPayments({ consumerId, limit: readPageParam(search.get("limit"), 50, 500) }), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
