// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, requireApiUser } from "@/src/lib/api-auth";
import { ApiClientError } from "@/src/lib/api-errors";
import { reviewsOpenCampaign } from "@/ee/access-reviews/decisions";
import { getCampaignEvidence } from "@/ee/access-reviews/evidence";
import { NO_STORE } from "@/ee/access-reviews/http";
import { parseRowId } from "@/src/lib/row-ids";

/**
 * ?campaignId=: evidence for the items of an open access review the caller
 * reviews. Being named as a reviewer is the authorization; any other
 * campaign answers 404.
 */
export async function GET(request: NextRequest) {
  try {
    const { userId } = await requireApiUser(request);
    const raw = request.nextUrl.searchParams.get("campaignId") ?? "";
    const campaignId = parseRowId(raw);
    if (campaignId === null || !await reviewsOpenCampaign(userId, campaignId)) throw new ApiClientError("Access review not found", 404);
    return NextResponse.json(await getCampaignEvidence(campaignId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
