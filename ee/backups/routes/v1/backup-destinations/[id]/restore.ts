// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission } from "@/src/lib/api-auth";
import { backupErrorResponse, NO_STORE, parseDestinationId, readJsonBody } from "@/ee/backups/http";
import { restoreBackup } from "@/ee/backups/runner";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "backups:restore");
    const id = parseDestinationId((await params).id);
    return NextResponse.json({ ok: true, ...(await restoreBackup(id, await readJsonBody(request), userId)) }, { headers: NO_STORE });
  } catch (error) {
    return backupErrorResponse(error);
  }
}
