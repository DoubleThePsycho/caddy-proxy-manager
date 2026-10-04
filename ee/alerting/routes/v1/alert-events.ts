// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { listAlertEvents } from "@/ee/alerting/events";
import { readPageParam } from "@/ee/alerting/http";
import { parseId } from "@/ee/alerting/validation";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "alerts:read");
    const { searchParams } = request.nextUrl;
    const ruleIdParam = searchParams.get("rule_id");
    return NextResponse.json(
      await listAlertEvents({
        page: readPageParam(searchParams.get("page"), 1, 100_000),
        perPage: readPageParam(searchParams.get("per_page"), 50, 200),
        ruleId: ruleIdParam ? parseId(ruleIdParam) : undefined,
      })
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
