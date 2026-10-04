// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission } from "@/src/lib/api-auth";
import { NO_STORE, ruleFeedErrorResponse } from "@/ee/rule-feed/http";
import { fetchRuleFeedNow } from "@/ee/rule-feed/service";

/** Fetches the feed from the configured URL now, verifies it and installs it. Needs the license. */
export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "virtual_patches:write");
    return NextResponse.json(await fetchRuleFeedNow(userId), { headers: NO_STORE });
  } catch (error) {
    return ruleFeedErrorResponse(error);
  }
}
