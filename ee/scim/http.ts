// SPDX-License-Identifier: Elastic-2.0
/**
 * The common path of every /scim/v2 request: authenticate the SCIM token,
 * refuse while SCIM is turned off, read the JSON body, and answer errors as
 * SCIM error documents.
 *
 * Only a SCIM token from scim_tokens authenticates: API tokens and dashboard
 * sessions are not accepted here (and SCIM tokens are not accepted by the
 * REST API).
 */
import type { NextRequest } from "next/server";
import { appDb } from "@/src/lib/db";
import { MAX_BODY_BYTES, ScimError, scimErrorResponse } from "./protocol";
import { readScimSettings } from "./store";
import { authenticateScimToken, type ScimTokenIdentity } from "./tokens";

export type ScimContext = { token: ScimTokenIdentity; params: URLSearchParams };

export async function handleScim(
  request: NextRequest,
  handler: (context: ScimContext) => Promise<Response> | Response
): Promise<Response> {
  try {
    const token = await authenticateScimToken(request.headers.get("authorization"));
    if (!token) throw new ScimError(401, "A valid SCIM bearer token is required");
    if (!(await readScimSettings(appDb)).enabled) {
      throw new ScimError(403, "SCIM provisioning is turned off on this server");
    }
    return await handler({ token, params: request.nextUrl.searchParams });
  } catch (error) {
    return scimErrorResponse(error);
  }
}

/** The request's JSON body (application/scim+json or application/json). */
export async function readScimBody(request: NextRequest): Promise<unknown> {
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    throw new ScimError(413, "The request body is too large");
  }
  if (!text.trim()) throw new ScimError(400, "The request body must be JSON", "invalidSyntax");
  try {
    return JSON.parse(text);
  } catch {
    throw new ScimError(400, "The request body must be JSON", "invalidSyntax");
  }
}
