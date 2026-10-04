// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { deleteAlertChannel, getAlertChannel, updateAlertChannel } from "@/ee/alerting/channels";
import { NO_STORE, readJsonBody } from "@/ee/alerting/http";
import { parseId } from "@/ee/alerting/validation";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "alerts:read");
    const channel = await getAlertChannel(parseId((await params).id));
    if (!channel) return NextResponse.json({ error: "Alert channel not found" }, { status: 404 });
    return NextResponse.json(channel, { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "alerts:write");
    const id = parseId((await params).id);
    return NextResponse.json(await updateAlertChannel(id, await readJsonBody(request), userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "alerts:write");
    await deleteAlertChannel(parseId((await params).id), userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
