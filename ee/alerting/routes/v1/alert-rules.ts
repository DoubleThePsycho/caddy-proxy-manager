// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { createAlertRule, listAlertRules } from "@/ee/alerting/rules";
import { readJsonBody } from "@/ee/alerting/http";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "alerts:read");
    return NextResponse.json(await listAlertRules());
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "alerts:write");
    return NextResponse.json(await createAlertRule(await readJsonBody(request), userId), { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
