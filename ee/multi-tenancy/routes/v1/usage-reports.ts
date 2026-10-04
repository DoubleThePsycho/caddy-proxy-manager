// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { buildUsageReport, parseUsagePeriod, usageReportCsv } from "@/ee/multi-tenancy/usage";
import { readOrganizationFilterParam } from "@/ee/multi-tenancy/scope";
import { NO_STORE } from "@/ee/multi-tenancy/http";

/**
 * Usage per organisation and period, as JSON or (?format=csv) CSV for
 * billing. Organisation users get their own organisation's only.
 */
export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "usage_reports:read");
    const params = request.nextUrl.searchParams;
    const format = (params.get("format") ?? "json").trim().toLowerCase();
    if (format !== "json" && format !== "csv") throw new ApiValidationError("format must be json or csv");
    const raw = params.get("organizationId");
    const report = await buildUsageReport(
      access,
      parseUsagePeriod(params),
      raw === null || raw.trim() === "" ? undefined : readOrganizationFilterParam({ organizationId: null }, raw)
    );
    if (format === "csv") {
      const stamp = report.period.from.slice(0, 10);
      return new Response(usageReportCsv(report), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="usage-${stamp}.csv"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    return NextResponse.json(report, { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
