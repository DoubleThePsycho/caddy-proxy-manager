// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { NO_STORE, readJsonBody, readPageParam } from "@/ee/compliance/http";
import { listRestoreTests, recordRestoreTest } from "@/ee/compliance/restore-tests";

/** Recorded test restores, newest first: ?page=&perPage=. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "compliance:read");
    const query = request.nextUrl.searchParams;
    return NextResponse.json(
      await listRestoreTests({ page: readPageParam(query.get("page"), 1, 100_000), perPage: readPageParam(query.get("perPage"), 25, 100) }),
      { headers: NO_STORE }
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Records a test restore: {testedAt, source, outcome, backupDestinationId?, backupObjectKey?, notes?}; license. */
export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "compliance:write");
    const test = await recordRestoreTest(await readJsonBody(request), userId);
    return NextResponse.json(test, { status: 201, headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
