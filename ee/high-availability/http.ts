// SPDX-License-Identifier: Elastic-2.0
/**
 * HTTP helpers of the certificate storage endpoints.
 */
import { NextResponse, type NextRequest } from "next/server";
import { apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { CertificateStorageApplyError } from "./service";

export const NO_STORE = { "Cache-Control": "no-store" };

/** apiErrorResponse, plus 502 when Caddy did not accept the storage (the previous setting was put back). */
export function storageErrorResponse(error: unknown): NextResponse {
  if (error instanceof CertificateStorageApplyError) {
    return NextResponse.json({ error: error.message }, { status: 502 });
  }
  return apiErrorResponse(error);
}

/** The JSON body, or undefined for an empty one. */
export async function readOptionalJson(request: NextRequest): Promise<unknown> {
  const text = await request.text();
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiValidationError("Request body must be JSON");
  }
}
