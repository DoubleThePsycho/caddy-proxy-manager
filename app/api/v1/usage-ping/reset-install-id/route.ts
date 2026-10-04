import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { resetUsagePingInstallId } from "@/src/lib/usage-ping/store";

/** Replaces the install id with a new random one (409 while the usage ping is off). */
export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "settings:write");
    return NextResponse.json(await resetUsagePingInstallId(userId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
