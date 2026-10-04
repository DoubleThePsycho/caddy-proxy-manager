import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { analyticsParams } from "@/src/lib/analytics/http";
import { resolveRange } from "@/src/lib/analytics/range";
import { querySecurityRules } from "@/src/lib/analytics/security";
import { parseTopLimit } from "@/src/lib/analytics/top";
import { scopeFor } from "@/src/lib/analytics/service";

export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "analytics:read");
    const params = analyticsParams(request.nextUrl.searchParams);
    const input = { range: resolveRange(params, undefined, "7d"), limit: parseTopLimit(params.limit) };
    return NextResponse.json(await querySecurityRules(input, await scopeFor(access)));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
