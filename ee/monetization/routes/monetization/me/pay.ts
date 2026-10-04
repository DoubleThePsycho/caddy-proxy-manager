// SPDX-License-Identifier: Elastic-2.0
import { NextResponse } from "next/server";
import { NO_STORE } from "@/ee/monetization/http";
import { consumerForApiKey, portalReturnUrl, startOpenAmountPayment } from "@/ee/monetization/portal";
import { monetizationErrorResponse } from "@/ee/monetization/responses";

/** Consumer API, postpaid: {url} of a Stripe Checkout Session paying the open amount, authenticated with the API key. */
export async function POST(request: Request): Promise<Response> {
  try {
    const consumer = await consumerForApiKey(request.headers);
    return NextResponse.json(await startOpenAmountPayment(consumer, portalReturnUrl(null)), { headers: NO_STORE });
  } catch (error) {
    return monetizationErrorResponse(error);
  }
}
