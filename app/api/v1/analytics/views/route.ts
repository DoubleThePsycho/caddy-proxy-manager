import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { createAnalyticsView, listAnalyticsViews } from "@/src/lib/models/analytics-views";

export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "analytics:read");
    return NextResponse.json(await listAnalyticsViews(access));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "analytics:read");
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiValidationError("Request body must be a JSON object");
    return NextResponse.json(await createAnalyticsView(access, body as Record<string, unknown>), { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
