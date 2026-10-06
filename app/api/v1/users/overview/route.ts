import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { getUsersOverview } from "@/src/lib/users-overview";

/**
 * GET /api/v1/users/overview — every account the caller may list, as the
 * Users page shows it: where it comes from, its second factor, who decides
 * its role, break-glass and last use. No password hash or secret.
 */
export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "users:read");
    return NextResponse.json(await getUsersOverview(access), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
