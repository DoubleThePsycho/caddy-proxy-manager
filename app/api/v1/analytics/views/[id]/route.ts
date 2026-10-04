import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { parseRouteId } from "@/src/lib/analytics/http";
import { deleteAnalyticsView, getAnalyticsView, updateAnalyticsView } from "@/src/lib/models/analytics-views";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Context) {
  try {
    const { access } = await requireApiPermission(request, "analytics:read");
    const { id } = await params;
    return NextResponse.json(await getAnalyticsView(access, parseRouteId(id, "View")));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest, { params }: Context) {
  try {
    const { access } = await requireApiPermission(request, "analytics:read");
    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiValidationError("Request body must be a JSON object");
    return NextResponse.json(await updateAnalyticsView(access, parseRouteId(id, "View"), body as Record<string, unknown>));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Context) {
  try {
    const { access } = await requireApiPermission(request, "analytics:read");
    const { id } = await params;
    await deleteAnalyticsView(access, parseRouteId(id, "View"));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
