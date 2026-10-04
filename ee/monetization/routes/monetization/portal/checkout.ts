// SPDX-License-Identifier: Elastic-2.0
import { NextResponse } from "next/server";
import { ApiClientError } from "@/src/lib/api-errors";
import { readJsonBody, requireRecord, NO_STORE } from "@/ee/monetization/http";
import { consumerForPortalToken, portalReturnUrl, startTopUp } from "@/ee/monetization/portal";
import { monetizationErrorResponse } from "@/ee/monetization/responses";

/**
 * Top-up from the self-service portal: {token, amountMicros} -> {url} of a
 * Stripe Checkout Session. Authenticated by the consumer's portal token.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = requireRecord(await readJsonBody(request));
    const consumer = await consumerForPortalToken(body.token);
    if (!consumer) throw new ApiClientError("This portal link is not valid", 404);
    const result = await startTopUp(consumer, body.amountMicros, portalReturnUrl(body.token as string));
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    return monetizationErrorResponse(error);
  }
}
