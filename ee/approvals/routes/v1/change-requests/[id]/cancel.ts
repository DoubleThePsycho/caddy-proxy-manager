// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { cancelChangeRequest, parseRequestId } from "@/ee/approvals/requests";
import { NO_STORE, readOptionalJsonBody } from "@/ee/approvals/http";

type Params = { params: Promise<{ id: string }> };

/** The requester cancels their own request; approvals:manage cancels anyone's (checked in cancelChangeRequest). */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { access } = await requireApiPermission(request, "approvals:read");
    const id = parseRequestId((await params).id);
    return NextResponse.json(await cancelChangeRequest(access, id, await readOptionalJsonBody(request)), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
