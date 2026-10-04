// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { createBackupDestination, listBackupDestinations } from "@/ee/backups/destinations";
import { NO_STORE, readJsonBody } from "@/ee/backups/http";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "backups:read");
    return NextResponse.json(await listBackupDestinations(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "backups:write");
    const destination = await createBackupDestination(await readJsonBody(request), userId);
    return NextResponse.json(destination, { status: 201, headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
