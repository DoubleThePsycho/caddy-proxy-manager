// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { NO_STORE, parseDestinationId, readPageParam } from "@/ee/backups/http";
import { listBackupRuns } from "@/ee/backups/runner";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "backups:read");
    const { searchParams } = request.nextUrl;
    const destinationParam = searchParams.get("destination_id");
    return NextResponse.json(
      await listBackupRuns({
        page: readPageParam(searchParams.get("page"), 1, 100_000),
        perPage: readPageParam(searchParams.get("per_page"), 50, 200),
        destinationId: destinationParam ? parseDestinationId(destinationParam) : undefined,
      }),
      { headers: NO_STORE }
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
