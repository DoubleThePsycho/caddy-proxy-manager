// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission } from "@/src/lib/api-auth";
import { NO_STORE, readFeedBody, ruleFeedErrorResponse } from "@/ee/rule-feed/http";
import { importRuleFeed } from "@/ee/rule-feed/service";
import { requireFeature } from "@/ee/licensing/store";
import { VIRTUAL_PATCHING_FEATURE } from "@/ee/rule-feed/types";

/**
 * Installs a feed file (the body, as published), verified exactly like a
 * fetched feed: for air-gapped installs. Needs the license.
 */
export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "virtual_patches:write");
    // Before reading a body of up to 4 MiB.
    await requireFeature(VIRTUAL_PATCHING_FEATURE);
    return NextResponse.json(await importRuleFeed(await readFeedBody(request), userId), { headers: NO_STORE });
  } catch (error) {
    return ruleFeedErrorResponse(error);
  }
}
