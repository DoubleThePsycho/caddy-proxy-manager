// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { NO_STORE } from "@/ee/compliance/http";
import { getControlStatus } from "@/ee/compliance/control-status";

/**
 * Live status of six controls (TLS, MFA for administrators, audit log
 * integrity, test restores, access reviews, WAF blocking), with what was
 * checked, the evidence and the NIS2 and ISO/IEC 27001 references.
 */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "compliance:read");
    return NextResponse.json(await getControlStatus(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
