import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { analyticsParams } from "@/src/lib/analytics/http";
import { parseFilters } from "@/src/lib/analytics/filters";
import { resolveRange } from "@/src/lib/analytics/range";
import { parseDimensions, parseTopLimit, queryTopDimensions } from "@/src/lib/analytics/top";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "analytics:read");
    const params = analyticsParams(request.nextUrl.searchParams);
    const input = {
      range: resolveRange(params),
      filters: parseFilters(params.filters),
      dimensions: parseDimensions(params.dimensions),
      limit: parseTopLimit(params.limit),
    };
    return NextResponse.json(await queryTopDimensions(input));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
