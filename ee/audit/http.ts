// SPDX-License-Identifier: Elastic-2.0
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import { SINK_NOT_FOUND } from "./sinks";
import { parseRowId } from "@/src/lib/row-ids";

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function readJsonBody(request: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiValidationError("Request body must be JSON");
  }
}

/** Route ids that are not positive integers name no sink. */
export function parseSinkId(raw: string): number {
  const id = parseRowId(raw);
  if (id === null) throw new ApiClientError(SINK_NOT_FOUND, 404);
  return id;
}
