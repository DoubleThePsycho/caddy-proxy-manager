import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { analyticsParams } from "@/src/lib/analytics/http";
import { parseFilters } from "@/src/lib/analytics/filters";
import { resolveRange } from "@/src/lib/analytics/range";
import { parsePaging, queryRequestLog } from "@/src/lib/analytics/requests";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "analytics:read");
    const params = analyticsParams(request.nextUrl.searchParams);
    const input = { range: resolveRange(params), filters: parseFilters(params.filters), ...parsePaging(params) };
    return NextResponse.json(await queryRequestLog(input));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
