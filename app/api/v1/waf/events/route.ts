import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { countWafEvents, listWafEvents } from "@/src/lib/models/waf-events";
import { WAF_NO_STORE, wafErrorResponse } from "@/src/lib/waf-api";

const MAX_RANGE_SECONDS = 400 * 24 * 60 * 60;

function readTime(value: string | null, label: string): number | undefined {
  if (value === null || value === "") return undefined;
  if (!/^\d{1,12}$/.test(value)) throw new ApiValidationError(`${label} must be a Unix time in seconds`);
  return Number(value);
}

/**
 * WAF events, newest first. Each event's `id` is Coraza's transaction id, for
 * GET /api/v1/waf/events/{id}/explain; `rawData` is left out (the explain
 * endpoint reads it).
 */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "waf:read");
    const { searchParams } = request.nextUrl;
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1);
    const perPage = Math.min(200, Math.max(1, parseInt(searchParams.get("perPage") ?? "50", 10) || 50));
    const search = searchParams.get("search")?.trim().slice(0, 200) || undefined;
    const from = readTime(searchParams.get("from"), "from");
    const to = readTime(searchParams.get("to"), "to");
    if ((from === undefined) !== (to === undefined)) throw new ApiValidationError("from and to go together");
    if (from !== undefined && to !== undefined && (from >= to || to - from > MAX_RANGE_SECONDS)) {
      throw new ApiValidationError("from must be before to, at most 400 days apart");
    }
    const offset = (page - 1) * perPage;
    const [events, total] = await Promise.all([
      listWafEvents(perPage, offset, search, from, to),
      countWafEvents(search, from, to),
    ]);
    return NextResponse.json(
      {
        events: events.map(({ id: _row, rawData: _raw, eventId, ...event }) => {
          void _row;
          void _raw;
          return { id: eventId || null, ...event };
        }),
        total,
        page,
        perPage,
      },
      { headers: WAF_NO_STORE }
    );
  } catch (error) {
    return wafErrorResponse(error);
  }
}
