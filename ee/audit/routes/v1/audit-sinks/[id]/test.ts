// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { testAuditSink } from "@/ee/audit/sinks";
import { NO_STORE, parseSinkId } from "@/ee/audit/http";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireApiPermission(request, "audit_streaming:write");
    const id = parseSinkId((await params).id);
    return NextResponse.json(await testAuditSink(id, userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
