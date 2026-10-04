// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { createApprovalPolicy, listApprovalPolicies } from "@/ee/approvals/policies";
import { NO_STORE, readJsonBody } from "@/ee/approvals/http";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "approvals:read");
    return NextResponse.json(await listApprovalPolicies(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "approvals:manage");
    const policy = await createApprovalPolicy(await readJsonBody(request), userId);
    return NextResponse.json(policy, { status: 201, headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
