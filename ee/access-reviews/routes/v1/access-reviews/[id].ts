// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, requireApiPermission } from "@/src/lib/api-auth";
import { deleteCampaign, getCampaign } from "@/ee/access-reviews/campaigns";
import { NO_STORE, parseRouteId } from "@/ee/access-reviews/http";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "access_reviews:read");
    return NextResponse.json(await getCampaign(parseRouteId((await params).id, "Access review not found")), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "access_reviews:write");
    await deleteCampaign(parseRouteId((await params).id, "Access review not found"), userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
