import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, getApiAccess, requireApiUser } from "@/src/lib/api-auth";
import { collectAttention } from "@/src/lib/attention";

/**
 * What needs attention, for the overview: each source (certificates, alerts,
 * approvals, access reviews, the fleet, backups, ...) answers only for
 * readers who hold one of its permissions, and only with what they may see.
 * Any signed-in user may call it; someone without any of those permissions
 * gets their own access review items, if any.
 */
export async function GET(request: NextRequest) {
  try {
    const access = await getApiAccess(await requireApiUser(request));
    return NextResponse.json(await collectAttention(access), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
