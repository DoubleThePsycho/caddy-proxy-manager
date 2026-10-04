// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission } from "@/src/lib/api-auth";
import { NO_STORE, readJsonBody, ruleFeedErrorResponse, ruleFeedStatus } from "@/ee/rule-feed/http";
import { getVirtualPatchingView, updateRuleFeedSubscription } from "@/ee/rule-feed/service";

/** The subscription, the installed feed and the last fetch or import. Readable without a license. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "virtual_patches:read");
    return NextResponse.json(ruleFeedStatus(await getVirtualPatchingView()), { headers: NO_STORE });
  } catch (error) {
    return ruleFeedErrorResponse(error);
  }
}

/** Subscribes, changes the feed URL or automatic blocking, or unsubscribes. Only turning things off works without a license. */
export async function PUT(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "virtual_patches:write");
    const view = await updateRuleFeedSubscription(await readJsonBody(request), userId);
    return NextResponse.json(ruleFeedStatus(view), { headers: NO_STORE });
  } catch (error) {
    return ruleFeedErrorResponse(error);
  }
}
