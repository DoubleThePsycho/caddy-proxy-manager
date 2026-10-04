// SPDX-License-Identifier: Elastic-2.0
import { ApiValidationError } from "@/src/lib/api-errors";

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function readJsonBody(request: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiValidationError("Request body must be JSON");
  }
}

/** A body that may be left out (approve, cancel, apply): none or unreadable is no body. */
export async function readOptionalJsonBody(request: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/** Positive integer query parameter with a default and an upper bound. */
export function readPageParam(value: string | null, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}
