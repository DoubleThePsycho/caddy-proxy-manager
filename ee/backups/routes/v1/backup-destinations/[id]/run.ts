// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { NO_STORE, parseDestinationId } from "@/ee/backups/http";
import { runBackupNow } from "@/ee/backups/runner";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "backups:write");
    return NextResponse.json(await runBackupNow(parseDestinationId((await params).id), userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
