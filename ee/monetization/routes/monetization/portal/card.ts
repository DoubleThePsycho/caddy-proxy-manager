// SPDX-License-Identifier: Elastic-2.0
import { NextResponse } from "next/server";
import { ApiClientError } from "@/src/lib/api-errors";
import { readJsonBody, requireRecord, NO_STORE } from "@/ee/monetization/http";
import { consumerForPortalToken, portalReturnUrl, startCardSetup } from "@/ee/monetization/portal";
import { monetizationErrorResponse } from "@/ee/monetization/responses";

/**
 * Postpaid: save a card from the self-service portal. {token} -> {url} of a
 * Stripe Checkout Session in setup mode. Authenticated by the portal token.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = requireRecord(await readJsonBody(request));
    const consumer = await consumerForPortalToken(body.token);
    if (!consumer) throw new ApiClientError("This portal link is not valid", 404);
    return NextResponse.json(await startCardSetup(consumer, portalReturnUrl(body.token as string)), { headers: NO_STORE });
  } catch (error) {
    return monetizationErrorResponse(error);
  }
}
