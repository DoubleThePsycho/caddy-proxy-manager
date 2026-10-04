// SPDX-License-Identifier: Elastic-2.0
import { NextResponse } from "next/server";
import { ApiClientError } from "@/src/lib/api-errors";
import { readJsonBody, requireRecord, NO_STORE } from "@/ee/monetization/http";
import { consumerForPortalToken, portalReturnUrl, startOpenAmountPayment } from "@/ee/monetization/portal";
import { monetizationErrorResponse } from "@/ee/monetization/responses";

/**
 * Postpaid: pay the open amount from the self-service portal. {token} ->
 * {url} of a Stripe Checkout Session. Authenticated by the portal token.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = requireRecord(await readJsonBody(request));
    const consumer = await consumerForPortalToken(body.token);
    if (!consumer) throw new ApiClientError("This portal link is not valid", 404);
    return NextResponse.json(await startOpenAmountPayment(consumer, portalReturnUrl(body.token as string)), { headers: NO_STORE });
  } catch (error) {
    return monetizationErrorResponse(error);
  }
}
