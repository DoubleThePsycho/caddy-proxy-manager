// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { compareVersions } from "@/ee/config-history/versions";

/**
 * ?from=<id|previous|current>&to=<id|current>: every difference going from
 * one version to the other, per host, row and settings group, field by
 * field. Secrets are never returned.
 */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "config_history:read");
    const params = request.nextUrl.searchParams;
    return NextResponse.json(await compareVersions(params.get("from"), params.get("to")), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
