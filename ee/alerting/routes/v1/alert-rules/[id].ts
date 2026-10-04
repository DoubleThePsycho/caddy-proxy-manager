// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { deleteAlertRule, getAlertRule, updateAlertRule } from "@/ee/alerting/rules";
import { readJsonBody } from "@/ee/alerting/http";
import { parseId } from "@/ee/alerting/validation";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "alerts:read");
    const rule = await getAlertRule(parseId((await params).id));
    if (!rule) return NextResponse.json({ error: "Alert rule not found" }, { status: 404 });
    return NextResponse.json(rule);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "alerts:write");
    const id = parseId((await params).id);
    return NextResponse.json(await updateAlertRule(id, await readJsonBody(request), userId));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "alerts:write");
    await deleteAlertRule(parseId((await params).id), userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
