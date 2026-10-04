// SPDX-License-Identifier: Elastic-2.0
/**
 * HTTP helpers of the shared state endpoints.
 */
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/src/lib/api-auth";
import { SharedStateChangeError } from "./service";

/** apiErrorResponse, plus 502 when the server could not be used or the balances not written back (nothing was changed). */
export function sharedStateErrorResponse(error: unknown): NextResponse {
  if (error instanceof SharedStateChangeError) {
    return NextResponse.json({ error: error.message }, { status: 502 });
  }
  return apiErrorResponse(error);
}
