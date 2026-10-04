/**
 * Small helpers shared by the /api/v1/waf routes.
 */
import { NextResponse } from "next/server";
import { apiErrorResponse, logUnexpectedApiError } from "./api-auth";
import { ApiValidationError } from "./api-errors";
import { WafApplyError } from "./models/waf-exclusions";
import { CaddyApplyError } from "./caddy-apply-error";
import { parseRowId } from "./row-ids";

export const WAF_NO_STORE = { "Cache-Control": "no-store" };

/** apiErrorResponse, with a refused Caddy configuration as 502 (the change was undone, or stored but not applied). */
export function wafErrorResponse(error: unknown): NextResponse {
  if (error instanceof WafApplyError) {
    logUnexpectedApiError("WAF change not applied", error.cause);
    return NextResponse.json({ error: error.message }, { status: 502 });
  }
  if (error instanceof CaddyApplyError) {
    logUnexpectedApiError("WAF change stored but not applied", error);
    return NextResponse.json(
      { error: "The change was saved, but Caddy did not accept the new configuration; it keeps the previous one until the next successful apply" },
      { status: 502 }
    );
  }
  return apiErrorResponse(error);
}

/** A positive integer path parameter. */
export function parseIdParam(raw: string, label: string): number {
  const id = parseRowId(raw);
  if (id === null) throw new ApiValidationError(`${label} must be a positive integer`);
  return id;
}

/** The request body as an object, or a 400. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiValidationError("Invalid JSON payload");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiValidationError("The request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

/** Refuses fields the endpoint does not know, so a typo is not silently ignored. */
export function onlyFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown) throw new ApiValidationError(`Unknown field: ${unknown}`);
}
