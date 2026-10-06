import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { countAuditEventsMatching, parseAuditFilter, queryAuditEvents } from "@/src/lib/models/audit";

/**
 * ?page=&per_page=&search=&actor=&action=&entityType=&entityId=&from=&to=
 * (every filter optional; newest first).
 */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "audit_log:read");
    const { searchParams } = request.nextUrl;
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1);
    const perPage = Math.min(200, Math.max(1, parseInt(searchParams.get("per_page") ?? "50", 10) || 50));
    const filter = parseAuditFilter(searchParams);
    const offset = (page - 1) * perPage;

    const [events, total] = await Promise.all([
      queryAuditEvents(filter, { limit: perPage, offset }),
      countAuditEventsMatching(filter),
    ]);

    return NextResponse.json({ events, total, page, perPage });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
