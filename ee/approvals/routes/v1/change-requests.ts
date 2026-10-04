// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { listChangeRequests, parseListFilter } from "@/ee/approvals/requests";
import { NO_STORE, readPageParam } from "@/ee/approvals/http";

export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "approvals:read");
    const query = request.nextUrl.searchParams;
    const page = await listChangeRequests(access, {
      status: parseListFilter(query.get("status")),
      page: readPageParam(query.get("page"), 1, 100_000),
      perPage: readPageParam(query.get("perPage"), 25, 100),
      mine: query.get("mine") === "true",
    });
    return NextResponse.json(page, { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
