// SPDX-License-Identifier: Elastic-2.0
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";

/** A license key is a few hundred bytes; the body {"key": "..."} never needs more than this. */
export const MAX_LICENSE_BODY_BYTES = 16 * 1024;

const TOO_LARGE = "The request body is too large for a license key";

/**
 * Reads {"key": "<license key>"} from a JSON body of at most
 * MAX_LICENSE_BODY_BYTES, stopping as soon as the limit is passed (a missing
 * or false Content-Length does not get around it).
 */
export async function readLicenseKeyBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_LICENSE_BODY_BYTES) {
    throw new ApiClientError(TOO_LARGE, 413);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_LICENSE_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ApiClientError(TOO_LARGE, 413);
      }
      chunks.push(value);
    }
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  } catch {
    throw new ApiValidationError("Request body must be JSON");
  }
  const key = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as { key?: unknown }).key : undefined;
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new ApiValidationError('Body must be {"key": "<license key>"}');
  }
  return key;
}
