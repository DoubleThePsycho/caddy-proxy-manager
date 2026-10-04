import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { analyticsParams, parseRouteId } from "@/src/lib/analytics/http";
import { resolveRange } from "@/src/lib/analytics/range";
import { hostDetailFor } from "@/src/lib/analytics/service";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { access } = await requireApiPermission(request, "analytics:read");
    const { id } = await params;
    const range = resolveRange(analyticsParams(request.nextUrl.searchParams));
    // 404 for a host outside the caller's tag scope or organisation, as for a missing one.
    return NextResponse.json(await hostDetailFor(access, parseRouteId(id, "Proxy host"), range));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
