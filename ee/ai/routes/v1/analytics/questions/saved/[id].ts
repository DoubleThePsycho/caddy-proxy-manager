// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission } from "@/src/lib/api-auth";
import { readJsonBody } from "@/ee/alerting/http";
import { parseRouteId } from "@/src/lib/analytics/http";
import { deleteSavedQuestion, getSavedQuestion, updateSavedQuestion } from "@/ee/ai/questions/saved";
import { NO_STORE, questionErrorResponse } from "@/ee/ai/questions/http";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Context) {
  try {
    const { access } = await requireApiPermission(request, "analytics:read");
    return NextResponse.json(await getSavedQuestion(access, parseRouteId((await params).id, "Question")), { headers: NO_STORE });
  } catch (error) {
    return questionErrorResponse(error);
  }
}

/** The owner changes question, query or shared. */
export async function PATCH(request: NextRequest, { params }: Context) {
  try {
    const { access } = await requireApiPermission(request, "analytics:read");
    const id = parseRouteId((await params).id, "Question");
    return NextResponse.json(await updateSavedQuestion(access, id, await readJsonBody(request)), { headers: NO_STORE });
  } catch (error) {
    return questionErrorResponse(error);
  }
}

/** The owner, or an administrator for a shared question. Report schedules keep their copies. */
export async function DELETE(request: NextRequest, { params }: Context) {
  try {
    const { access } = await requireApiPermission(request, "analytics:read");
    await deleteSavedQuestion(access, parseRouteId((await params).id, "Question"));
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return questionErrorResponse(error);
  }
}
