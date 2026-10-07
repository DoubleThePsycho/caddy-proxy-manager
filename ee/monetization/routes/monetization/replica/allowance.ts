// SPDX-License-Identifier: Elastic-2.0
import { handleAllowanceHttp } from "@/ee/monetization/replica-allowance";

/**
 * API monetization on sync replicas: a replica asks its master's gate for an
 * allowance (requests the master reserves from a consumer's balance before
 * the replica admits them) and reports what it used of earlier ones.
 * Authenticated with the replica's allowance credential, derived from its
 * sync secret (never the secret itself; ee/monetization/replica-allowance.ts),
 * after a per-address limit on failed attempts.
 */

export async function POST(request: Request): Promise<Response> {
  return handleAllowanceHttp(request);
}
