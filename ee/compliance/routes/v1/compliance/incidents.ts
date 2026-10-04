// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { NO_STORE, readJsonBody, readPageParam } from "@/ee/compliance/http";
import { createIncident, listIncidents } from "@/ee/compliance/incidents";

/** The incident register: ?status=open|closed&page=&perPage= (latest incident first). */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "compliance:read");
    const query = request.nextUrl.searchParams;
    const status = query.get("status");
    if (status !== null && status !== "open" && status !== "closed") throw new ApiValidationError("status must be open or closed");
    const page = await listIncidents({
      page: readPageParam(query.get("page"), 1, 100_000),
      perPage: readPageParam(query.get("perPage"), 25, 100),
      status,
    });
    return NextResponse.json(page, { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "compliance:write");
    const incident = await createIncident(await readJsonBody(request), userId);
    return NextResponse.json(incident, {
      status: 201,
      headers: { ...NO_STORE, Location: `/api/v1/compliance/incidents/${incident.id}` },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
