import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { trafficSignalsFor } from "@/src/lib/analytics/service";

export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "analytics:read");
    return NextResponse.json(await trafficSignalsFor(access));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
