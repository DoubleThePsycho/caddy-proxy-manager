// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { NO_STORE } from "@/ee/compliance/http";
import { describeControlMapping } from "@/ee/compliance/controls";

/** The control mapping of every report and of the incident drafts. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "compliance:read");
    return NextResponse.json(describeControlMapping(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
