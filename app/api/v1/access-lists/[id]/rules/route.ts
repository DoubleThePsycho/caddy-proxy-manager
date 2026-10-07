import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { addAccessListRule, getAccessList, replaceAccessListRules } from "@/src/lib/models/access-lists";
import { readJsonBody, readObjectBody } from "@/src/lib/access-list-http";
import { routeRowId } from "@/src/lib/row-ids";

/** The list's rules, in the order they are checked. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireApiPermission(request, "access_lists:read");
    const { id } = await params;
    const list = await getAccessList(routeRowId(id, "Not found"));
    if (!list) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(list.rules);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Adds a rule; `position` (0-based) puts it there, the default is last. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await requireApiPermission(request, "access_lists:write");
    const { id } = await params;
    const body = readObjectBody(await readJsonBody(request), "The rule");
    const rule = await addAccessListRule(routeRowId(id), body, userId, { position: body.position });
    return NextResponse.json(rule, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Replaces every rule, in order: `{ "rules": [...] }` (rules sent with their id keep it). */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await requireApiPermission(request, "access_lists:write");
    const { id } = await params;
    const body = readObjectBody(await readJsonBody(request));
    const rules = await replaceAccessListRules(routeRowId(id), body.rules, userId);
    return NextResponse.json(rules);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
