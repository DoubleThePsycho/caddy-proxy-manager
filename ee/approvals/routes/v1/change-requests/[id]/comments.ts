// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { commentOnChangeRequest, parseRequestId } from "@/ee/approvals/requests";
import { NO_STORE, readJsonBody } from "@/ee/approvals/http";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { access } = await requireApiPermission(request, "approvals:read");
    const id = parseRequestId((await params).id);
    return NextResponse.json(await commentOnChangeRequest(access, id, await readJsonBody(request)), { status: 201, headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
