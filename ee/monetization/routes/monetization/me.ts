// SPDX-License-Identifier: Elastic-2.0
import { NextResponse } from "next/server";
import { NO_STORE } from "@/ee/monetization/http";
import { consumerForApiKey, consumerSummary } from "@/ee/monetization/portal";
import { monetizationErrorResponse } from "@/ee/monetization/responses";

/**
 * Consumer API: the caller's balance, plan, free requests and recent
 * activity, authenticated with the consumer's own API key
 * (Authorization: Bearer <key> or X-API-Key). Not billed.
 */

export async function GET(request: Request): Promise<Response> {
  try {
    return NextResponse.json(await consumerSummary(await consumerForApiKey(request.headers)), { headers: NO_STORE });
  } catch (error) {
    return monetizationErrorResponse(error);
  }
}
