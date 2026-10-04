// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { sendDigestNow } from "@/ee/ai/digest";
import { NO_STORE } from "@/ee/alerting/http";

export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "ai:write");
    return NextResponse.json(await sendDigestNow(userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
