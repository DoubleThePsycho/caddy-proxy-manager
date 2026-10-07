// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { deleteSnapshot, getSnapshotDetail, parseSnapshotId } from "@/ee/config-history/service";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "config_history:read");
    const { id } = await params;
    return NextResponse.json(await getSnapshotDetail(parseSnapshotId(id)));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Deletes the snapshot. */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "config_history:write");
    const { id } = await params;
    await deleteSnapshot(parseSnapshotId(id), userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
