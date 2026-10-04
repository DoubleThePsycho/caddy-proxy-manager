// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { getSnapshotDiff, parseSnapshotId } from "@/ee/config-history/service";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "config_history:read");
    const { id } = await params;
    const diff = await getSnapshotDiff(parseSnapshotId(id), request.nextUrl.searchParams.get("against"));
    return NextResponse.json(diff, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
