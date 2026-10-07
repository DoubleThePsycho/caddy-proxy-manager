import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { analyticsParams } from "@/src/lib/analytics/http";
import { parseAnalyticsQuery, queryAnalytics } from "@/src/lib/analytics/query";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "analytics:read");
    const query = parseAnalyticsQuery(analyticsParams(request.nextUrl.searchParams));
    return NextResponse.json(await queryAnalytics(query));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
