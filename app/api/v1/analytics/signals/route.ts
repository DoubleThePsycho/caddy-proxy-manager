import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { trafficSignalsFor } from "@/src/lib/analytics/service";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "analytics:read");
    return NextResponse.json(await trafficSignalsFor());
  } catch (error) {
    return apiErrorResponse(error);
  }
}
