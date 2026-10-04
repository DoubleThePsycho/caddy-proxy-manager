// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { deleteBackupDestination, getBackupDestination, updateBackupDestination } from "@/ee/backups/destinations";
import { NO_STORE, parseDestinationId, readJsonBody } from "@/ee/backups/http";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "backups:read");
    return NextResponse.json(await getBackupDestination(parseDestinationId((await params).id)), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "backups:write");
    const id = parseDestinationId((await params).id);
    return NextResponse.json(await updateBackupDestination(id, await readJsonBody(request), userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "backups:write");
    await deleteBackupDestination(parseDestinationId((await params).id), userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
