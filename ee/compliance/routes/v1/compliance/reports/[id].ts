// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { NO_STORE, parseRouteId } from "@/ee/compliance/http";
import { deleteReport, getReport, REPORT_NOT_FOUND } from "@/ee/compliance/reports";

type Params = { params: Promise<{ id: string }> };

/** The stored report with its content and an integrity check. */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "compliance:read");
    return NextResponse.json(await getReport(parseRouteId((await params).id, REPORT_NOT_FOUND)), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "compliance:write");
    await deleteReport(parseRouteId((await params).id, REPORT_NOT_FOUND), userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
