// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { deleteApprovalPolicy, getApprovalPolicy, parsePolicyId, updateApprovalPolicy } from "@/ee/approvals/policies";
import { NO_STORE, readJsonBody } from "@/ee/approvals/http";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "approvals:read");
    return NextResponse.json(await getApprovalPolicy(parsePolicyId((await params).id)), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "approvals:manage");
    const id = parsePolicyId((await params).id);
    return NextResponse.json(await updateApprovalPolicy(id, await readJsonBody(request), userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "approvals:manage");
    await deleteApprovalPolicy(parsePolicyId((await params).id), userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
