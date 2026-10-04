import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { getUsagePingView, parseUsagePingInput, setUsagePingEnabled } from "@/src/lib/usage-ping/store";

const NO_STORE = { "Cache-Control": "no-store" };

/** The usage ping setting, its status and exactly what the next ping sends. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "settings:read");
    return NextResponse.json(await getUsagePingView(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Answer yes (a new random install id) or no (the id is deleted). */
export async function PUT(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "settings:write");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiValidationError("Request body must be JSON");
    }
    const { enabled } = parseUsagePingInput(body);
    return NextResponse.json(await setUsagePingEnabled(enabled, userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
