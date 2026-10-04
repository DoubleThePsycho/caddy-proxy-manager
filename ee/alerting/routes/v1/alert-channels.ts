// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { createAlertChannel, listAlertChannels } from "@/ee/alerting/channels";
import { NO_STORE, readJsonBody } from "@/ee/alerting/http";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "alerts:read");
    return NextResponse.json(await listAlertChannels(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "alerts:write");
    const channel = await createAlertChannel(await readJsonBody(request), userId);
    return NextResponse.json(channel, { status: 201, headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
