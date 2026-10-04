import { ApiValidationError } from "./api-errors";

/** The request's JSON body; a missing or malformed body is a 400. */
export async function readJsonBody(request: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiValidationError("Request body must be JSON");
  }
}

/** The fields of a JSON object body; anything else is a 400. */
export function readObjectBody(body: unknown, what = "Request body"): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiValidationError(`${what} must be a JSON object`);
  }
  return body as Record<string, unknown>;
}
