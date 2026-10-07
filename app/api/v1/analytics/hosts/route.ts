import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { analyticsParams, parseIdList } from "@/src/lib/analytics/http";
import { resolveRange } from "@/src/lib/analytics/range";
import { hostSummariesFor } from "@/src/lib/analytics/service";

export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "analytics:read");
    const params = analyticsParams(request.nextUrl.searchParams);
    // Only proxy hosts the caller's role reaches (tag scope included).
    return NextResponse.json(await hostSummariesFor(access, resolveRange(params), parseIdList(params.ids, "ids")));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
