// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { listVersions } from "@/ee/config-history/versions";

function intParam(value: string | null, fallback: number): number {
  if (value === null || value === "") return fallback;
  if (!/^\d{1,9}$/.test(value)) throw new ApiValidationError("limit and offset must be non-negative integers");
  return Number(value);
}

/** Versions, newest first, each with a readable title, who made it and how big the change was. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "config_history:read");
    const params = request.nextUrl.searchParams;
    const list = await listVersions({ limit: intParam(params.get("limit"), 50), offset: intParam(params.get("offset"), 0) });
    return NextResponse.json(list, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
