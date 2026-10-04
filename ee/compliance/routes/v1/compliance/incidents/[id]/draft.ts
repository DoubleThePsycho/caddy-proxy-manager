// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission } from "@/src/lib/api-auth";
import { complianceErrorResponse, NO_STORE, parseRouteId, readJsonBody } from "@/ee/compliance/http";
import { draftIncidentStage, INCIDENT_NOT_FOUND } from "@/ee/compliance/incidents";

/** {stage, source: "template" | "ai"}: fills a stage's text. 502 when the AI provider fails. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireApiPermission(request, "compliance:write");
    const id = parseRouteId((await params).id, INCIDENT_NOT_FOUND);
    return NextResponse.json(await draftIncidentStage(id, await readJsonBody(request), userId), { headers: NO_STORE });
  } catch (error) {
    return complianceErrorResponse(error);
  }
}
