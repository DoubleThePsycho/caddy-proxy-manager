// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { deleteAuditSink, getAuditSink, updateAuditSink } from "@/ee/audit/sinks";
import { NO_STORE, parseSinkId, readJsonBody } from "@/ee/audit/http";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "audit_streaming:read");
    const id = parseSinkId((await params).id);
    return NextResponse.json(await getAuditSink(id), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "audit_streaming:write");
    const id = parseSinkId((await params).id);
    const body = await readJsonBody(request);
    return NextResponse.json(await updateAuditSink(id, body, userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "audit_streaming:write");
    const id = parseSinkId((await params).id);
    await deleteAuditSink(id, userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
