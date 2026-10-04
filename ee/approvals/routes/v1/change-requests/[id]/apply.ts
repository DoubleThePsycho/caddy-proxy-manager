// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { applyChangeRequestNow, parseRequestId } from "@/ee/approvals/requests";
import { NO_STORE } from "@/ee/approvals/http";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { access } = await requireApiPermission(request, "approvals:approve");
    return NextResponse.json(await applyChangeRequestNow(access, parseRequestId((await params).id)), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
