// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { parseRouteId } from "@/ee/compliance/http";
import { deleteRestoreTest, RESTORE_TEST_NOT_FOUND } from "@/ee/compliance/restore-tests";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "compliance:write");
    await deleteRestoreTest(parseRouteId((await params).id, RESTORE_TEST_NOT_FOUND), userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
