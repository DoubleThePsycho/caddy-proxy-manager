// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission } from "@/src/lib/api-auth";
import { NO_STORE, ruleFeedErrorResponse } from "@/ee/rule-feed/http";
import { getVirtualPatchingView } from "@/ee/rule-feed/service";

/** Every virtual patch with its CVE details, rules, samples and mode. Readable without a license. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "virtual_patches:read");
    const view = await getVirtualPatchingView();
    return NextResponse.json({ patches: view.patches, counts: view.counts, source: view.source }, { headers: NO_STORE });
  } catch (error) {
    return ruleFeedErrorResponse(error);
  }
}
