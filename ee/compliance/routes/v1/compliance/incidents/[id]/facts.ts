// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { NO_STORE, parseRouteId } from "@/ee/compliance/http";
import { INCIDENT_NOT_FOUND, refreshIncidentFacts } from "@/ee/compliance/incidents";

/** Collects the draft's facts again (WAF and traffic figures, alerts, changes). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireApiPermission(request, "compliance:write");
    const id = parseRouteId((await params).id, INCIDENT_NOT_FOUND);
    return NextResponse.json(await refreshIncidentFacts(id, userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
