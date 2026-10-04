import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, getApiAccess, requireApiUser } from "@/src/lib/api-auth";
import { searchDashboard } from "@/src/lib/search";

/**
 * GET /api/v1/search?q= — the command palette's search. Any signed-in user
 * or API token may call it; every group of results is limited inside
 * searchDashboard to what the caller's role can read (src/lib/search.ts).
 */
export async function GET(request: NextRequest) {
  try {
    const access = await getApiAccess(await requireApiUser(request));
    const response = await searchDashboard(access, request.nextUrl.searchParams.get("q") ?? "");
    return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
