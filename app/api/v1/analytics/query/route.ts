import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { analyticsParams } from "@/src/lib/analytics/http";
import { parseAnalyticsQuery, queryAnalytics } from "@/src/lib/analytics/query";
import { scopeFor } from "@/src/lib/analytics/service";

export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "analytics:read");
    const query = parseAnalyticsQuery(analyticsParams(request.nextUrl.searchParams));
    // Organisation users (and a provider's organisation view) only see their organisation's hosts.
    return NextResponse.json(await queryAnalytics(query, await scopeFor(access)));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
