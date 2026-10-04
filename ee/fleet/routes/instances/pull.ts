// SPDX-License-Identifier: Elastic-2.0
import type { NextRequest } from "next/server";
import { handlePullRequest } from "@/ee/fleet/pull-server";

/**
 * A pull replica's poll (ee/fleet/pull-server.ts): authenticated with the
 * replica's own pull credential, not a session or an API token, with its own
 * rate limits. Answered in master mode only.
 */
export async function POST(request: NextRequest) {
  return handlePullRequest(request);
}
