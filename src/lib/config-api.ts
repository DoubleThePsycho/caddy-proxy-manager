import { NextResponse } from "next/server";
import { apiErrorResponse } from "./api-auth";
import { ConfigurationApplyError } from "./config-replace";

/**
 * apiErrorResponse, plus 502 for a configuration Caddy did not accept (the
 * previous configuration was put back; the message is safe to show).
 */
export function configurationErrorResponse(error: unknown): NextResponse {
  if (error instanceof ConfigurationApplyError) {
    return NextResponse.json({ error: error.message }, { status: 502 });
  }
  return apiErrorResponse(error);
}
