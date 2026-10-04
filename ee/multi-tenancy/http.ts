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
