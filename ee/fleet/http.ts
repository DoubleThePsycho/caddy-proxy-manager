// SPDX-License-Identifier: Elastic-2.0
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import { parseRowId } from "@/src/lib/row-ids";

export const NO_STORE = { "Cache-Control": "no-store" } as const;

/** The request's JSON body; a missing or malformed body is a 400. */
export async function readJsonBody(request: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiValidationError("Request body must be JSON");
  }
}

/** A route id that is not a positive integer names nothing: 404 with `notFound`. */
export function parseRouteId(raw: string, notFound: string): number {
  const id = parseRowId(raw);
  if (id === null) throw new ApiClientError(notFound, 404);
  return id;
}

/** Positive integer query parameter with a default and an upper bound. */
export function readPageParam(value: string | null, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}
