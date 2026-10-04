import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { analyticsParams } from "@/src/lib/analytics/http";
import { parseFilters } from "@/src/lib/analytics/filters";
import { resolveRange } from "@/src/lib/analytics/range";
import { parsePaging, queryRequestLog } from "@/src/lib/analytics/requests";
import { scopeFor } from "@/src/lib/analytics/service";

export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "analytics:read");
    const params = analyticsParams(request.nextUrl.searchParams);
    const input = { range: resolveRange(params), filters: parseFilters(params.filters), ...parsePaging(params) };
    return NextResponse.json(await queryRequestLog(input, await scopeFor(access)));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
