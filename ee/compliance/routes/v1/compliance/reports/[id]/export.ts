// SPDX-License-Identifier: Elastic-2.0
import { NextRequest } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { parseRouteId } from "@/ee/compliance/http";
import { fileHeaders, getReport, parseExportQuery, REPORT_NOT_FOUND, reportFile } from "@/ee/compliance/reports";

/** ?format=json|csv&section= : the stored report as a file. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireApiPermission(request, "compliance:read");
    const id = parseRouteId((await params).id, REPORT_NOT_FOUND);
    const query = parseExportQuery(request.nextUrl.searchParams);
    const file = reportFile(await getReport(id), query.format, query.section);
    return new Response(file.body, { headers: fileHeaders(file) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
