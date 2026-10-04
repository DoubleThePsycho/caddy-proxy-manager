import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { getSetupChecklist, updateSetupChecklist } from "@/src/lib/setup-checklist";

/** The setup checklist: each step's state, read from the data or marked done by hand. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "settings:read");
    return NextResponse.json(await getSetupChecklist(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** {steps?: {<step>: true|false}, dismissed?: true|false}. */
export async function PUT(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "settings:write");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiValidationError("Request body must be JSON");
    }
    return NextResponse.json(await updateSetupChecklist(body, userId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
