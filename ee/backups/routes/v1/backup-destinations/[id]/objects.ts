// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission } from "@/src/lib/api-auth";
import { backupErrorResponse, NO_STORE, parseDestinationId } from "@/ee/backups/http";
import { listBackupObjects } from "@/ee/backups/runner";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "backups:read");
    return NextResponse.json(await listBackupObjects(parseDestinationId((await params).id)), { headers: NO_STORE });
  } catch (error) {
    return backupErrorResponse(error);
  }
}
