import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { reorderAccessListRules } from "@/src/lib/models/access-lists";
import { readJsonBody, readObjectBody } from "@/src/lib/access-list-http";
import { routeRowId } from "@/src/lib/row-ids";

/** Puts the rules in the order of `ruleIds`, which must name every rule of the list once. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await requireApiPermission(request, "access_lists:write");
    const { id } = await params;
    const body = readObjectBody(await readJsonBody(request));
    const rules = await reorderAccessListRules(routeRowId(id), body.ruleIds, userId);
    return NextResponse.json(rules);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
