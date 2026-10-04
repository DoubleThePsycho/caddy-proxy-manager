// SPDX-License-Identifier: Elastic-2.0
import { NextResponse } from "next/server";
import { readJsonBody, requireRecord, NO_STORE } from "@/ee/monetization/http";
import { consumerForApiKey, portalReturnUrl, startTopUp } from "@/ee/monetization/portal";
import { monetizationErrorResponse } from "@/ee/monetization/responses";

/** Consumer API: {amountMicros} -> {url} of a Stripe Checkout Session, authenticated with the API key. */
export async function POST(request: Request): Promise<Response> {
  try {
    const consumer = await consumerForApiKey(request.headers);
    const body = requireRecord(await readJsonBody(request));
    return NextResponse.json(await startTopUp(consumer, body.amountMicros, portalReturnUrl(null)), { headers: NO_STORE });
  } catch (error) {
    return monetizationErrorResponse(error);
  }
}
