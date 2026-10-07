// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { NO_STORE, parseRouteId, readJsonBody } from "@/ee/compliance/http";
import { deleteIncident, getIncident, INCIDENT_NOT_FOUND, updateIncident } from "@/ee/compliance/incidents";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "compliance:read");
    return NextResponse.json(await getIncident(parseRouteId((await params).id, INCIDENT_NOT_FOUND)), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "compliance:write");
    const id = parseRouteId((await params).id, INCIDENT_NOT_FOUND);
    return NextResponse.json(await updateIncident(id, await readJsonBody(request), userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "compliance:write");
    await deleteIncident(parseRouteId((await params).id, INCIDENT_NOT_FOUND), userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
