// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { NO_STORE, parseRouteId } from "@/ee/access-reviews/http";
import { getCampaignEvidence } from "@/ee/access-reviews/evidence";

type Params = { params: Promise<{ id: string }> };

/**
 * Evidence for every item of a campaign: each person's sign-in sources,
 * last sign-in, sign-ins in 30 days and last change, and when each access
 * was last used. Read now from the audit log and the accounts.
 */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "access_reviews:read");
    return NextResponse.json(await getCampaignEvidence(parseRouteId((await params).id, "Access review not found")), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
