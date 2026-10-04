// SPDX-License-Identifier: Elastic-2.0
/**
 * Request helpers of the SCIM administration endpoints (/api/v1/scim/*).
 */
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import { parseRowId } from "@/src/lib/row-ids";

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function readJsonBody(request: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiValidationError("Request body must be JSON");
  }
}

/** Route ids that are not positive integers name nothing. */
export function parseRouteId(raw: string, notFound: string): number {
  const id = parseRowId(raw);
  if (id === null) throw new ApiClientError(notFound, 404);
  return id;
}
