// SPDX-License-Identifier: Elastic-2.0
import { handleGateRequest } from "@/ee/monetization/gate-response";

/**
 * API monetization gate: called by Caddy as a forward_auth-style subrequest
 * for every request to a monetized proxy host. Refuses calls without the
 * per-install gate token. Decides from memory without a database query, or
 * with high availability shared state with one atomic script in Redis/Valkey.
 */

export async function GET(request: Request): Promise<Response> {
  return handleGateRequest(request.headers);
}
