import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { analyticsParams } from "@/src/lib/analytics/http";
import { resolveRange } from "@/src/lib/analytics/range";
import { parsePaging } from "@/src/lib/analytics/requests";
import { parseEventKinds, parseSecurityEventFilters, querySecurityEvents } from "@/src/lib/analytics/security";
import { scopeFor } from "@/src/lib/analytics/service";

export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "analytics:read");
    const params = analyticsParams(request.nextUrl.searchParams);
    const input = {
      range: resolveRange(params, undefined, "7d"),
      kinds: parseEventKinds(params.kind),
      filters: parseSecurityEventFilters(params.filters),
      ...parsePaging(params),
    };
    // The raw Coraza audit records stay with the WAF events (GET /api/waf-events, waf:read).
    return NextResponse.json(await querySecurityEvents(input, await scopeFor(access)));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
