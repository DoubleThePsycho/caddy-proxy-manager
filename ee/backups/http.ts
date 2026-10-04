// SPDX-License-Identifier: Elastic-2.0
import { NextResponse } from "next/server";
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import { configurationErrorResponse } from "@/src/lib/config-api";
import { DESTINATION_NOT_FOUND } from "./destinations";
import { S3Error } from "./s3";
import { parseRowId } from "@/src/lib/row-ids";

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function readJsonBody(request: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiValidationError("Request body must be JSON");
  }
}

/** Route ids that are not positive integers name no destination. */
export function parseDestinationId(raw: string): number {
  const id = parseRowId(raw);
  if (id === null) throw new ApiClientError(DESTINATION_NOT_FOUND, 404);
  return id;
}

/** Positive integer query parameter with a default and an upper bound. */
export function readPageParam(value: string | null, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

/**
 * apiErrorResponse, plus 502 for a failure of the storage (its message names
 * the status and S3 error code only) and for a configuration Caddy rejected.
 */
export function backupErrorResponse(error: unknown): NextResponse {
  if (error instanceof S3Error) {
    return NextResponse.json({ error: `The storage request failed: ${error.message}` }, { status: 502 });
  }
  return configurationErrorResponse(error);
}
