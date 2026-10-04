// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { NO_STORE, readJsonBody, readPageParam } from "@/ee/compliance/http";
import { fileHeaders, generateReport, listReports, reportFile } from "@/ee/compliance/reports";
import { isReportType, REPORT_TYPES } from "@/ee/compliance/types";

/** ?type=&packId=&page=&perPage= (newest first). Stored reports without their content. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "compliance:read");
    const query = request.nextUrl.searchParams;
    const type = query.get("type");
    if (type !== null && !isReportType(type)) throw new ApiValidationError(`type must be one of: ${REPORT_TYPES.join(", ")}`);
    const packId = query.get("packId");
    if (packId !== null && !/^[0-9a-f-]{36}$/i.test(packId)) throw new ApiValidationError("packId must be the id of an evidence pack");
    const page = await listReports({
      type,
      packId,
      page: readPageParam(query.get("page"), 1, 100_000),
      perPage: readPageParam(query.get("perPage"), 25, 100),
    });
    return NextResponse.json(page, { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Generates and stores a report: {type, from?, to?, format?}. Answers with the report, or its first table as CSV. */
export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "compliance:write");
    const { detail, format } = await generateReport(await readJsonBody(request), userId);
    const location = `/api/v1/compliance/reports/${detail.id}`;
    if (format === "csv") {
      const file = reportFile(detail, "csv", null);
      return new Response(file.body, { status: 201, headers: { ...fileHeaders(file), Location: location } });
    }
    return NextResponse.json(detail, { status: 201, headers: { ...NO_STORE, Location: location } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
