// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, requireApiPermission } from "@/src/lib/api-auth";
import { cancelCampaign } from "@/ee/access-reviews/campaigns";
import { NO_STORE, parseRouteId } from "@/ee/access-reviews/http";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "access_reviews:write");
    return NextResponse.json(await cancelCampaign(parseRouteId((await params).id, "Access review not found"), userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
