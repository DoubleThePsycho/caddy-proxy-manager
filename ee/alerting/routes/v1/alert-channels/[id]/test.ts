// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { testAlertChannel } from "@/ee/alerting/test-channel";
import { parseId } from "@/ee/alerting/validation";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "alerts:write");
    return NextResponse.json(await testAlertChannel(parseId((await params).id), userId));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
