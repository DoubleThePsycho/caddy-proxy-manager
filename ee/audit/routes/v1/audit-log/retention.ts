// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { getAuditRetention, setAuditRetention } from "@/ee/audit/retention";
import { NO_STORE, readJsonBody } from "@/ee/audit/http";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "audit_streaming:read");
    return NextResponse.json(await getAuditRetention(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "audit_streaming:write");
    const body = await readJsonBody(request);
    return NextResponse.json(await setAuditRetention(body, userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
