import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { analyticsParams } from "@/src/lib/analytics/http";
import { resolveRange } from "@/src/lib/analytics/range";
import { querySecuritySeries } from "@/src/lib/analytics/security";
import { scopeFor } from "@/src/lib/analytics/service";

export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "analytics:read");
    const range = resolveRange(analyticsParams(request.nextUrl.searchParams), undefined, "7d");
    return NextResponse.json(await querySecuritySeries({ range }, await scopeFor(access)));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
