// SPDX-License-Identifier: Elastic-2.0
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/src/lib/api-auth";
import { PaymentProviderError } from "./payments";

/** apiErrorResponse, plus 502 when Stripe refused or could not be reached (the message is safe to show). */
export function monetizationErrorResponse(error: unknown): NextResponse {
  if (error instanceof PaymentProviderError) {
    return NextResponse.json({ error: error.message }, { status: 502 });
  }
  return apiErrorResponse(error);
}
