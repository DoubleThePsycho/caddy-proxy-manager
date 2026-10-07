// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { deleteAlertSilence } from "@/ee/alerting/silences";
import { parseId } from "@/ee/alerting/validation";

type Params = { params: Promise<{ id: string }> };

/** Ends a dismissal or mute. */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "alerts:write");
    await deleteAlertSilence(parseId((await params).id), userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
