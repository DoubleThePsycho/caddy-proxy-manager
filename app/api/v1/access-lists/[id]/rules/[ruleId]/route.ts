import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { getAccessList, removeAccessListRule, updateAccessListRule } from "@/src/lib/models/access-lists";
import { readJsonBody } from "@/src/lib/access-list-http";
import { parseRowId, routeRowId } from "@/src/lib/row-ids";

type Params = { params: Promise<{ id: string; ruleId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "access_lists:read");
    const { id, ruleId } = await params;
    const list = await getAccessList(routeRowId(id, "Not found"));
    const rule = list?.rules.find((item) => item.id === parseRowId(ruleId));
    if (!rule) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(rule);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Replaces the rule's action, kind, values, note and expiry; its position stays. */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "access_lists:write");
    const { id, ruleId } = await params;
    const body = await readJsonBody(request);
    const rule = await updateAccessListRule(routeRowId(id), routeRowId(ruleId), body, userId);
    return NextResponse.json(rule);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "access_lists:write");
    const { id, ruleId } = await params;
    await removeAccessListRule(routeRowId(id), routeRowId(ruleId), userId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
