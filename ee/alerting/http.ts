// SPDX-License-Identifier: Elastic-2.0
import { ApiValidationError } from "@/src/lib/api-errors";

export const NO_STORE = { "Cache-Control": "no-store" };

/** The request's JSON body; a missing or malformed body is a 400. */
export async function readJsonBody(request: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiValidationError("Request body must be JSON");
  }
}

/** Positive integer query parameter with a default and an upper bound. */
export function readPageParam(value: string | null, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}
