// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { createAuditSink, listAuditSinks } from "@/ee/audit/sinks";
import { NO_STORE, readJsonBody } from "@/ee/audit/http";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "audit_streaming:read");
    return NextResponse.json(await listAuditSinks(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "audit_streaming:write");
    const body = await readJsonBody(request);
    return NextResponse.json(await createAuditSink(body, userId), { status: 201, headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
