// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission } from "@/src/lib/api-auth";
import { readJsonBody } from "@/ee/alerting/http";
import { createSavedQuestion, listSavedQuestions } from "@/ee/ai/questions/saved";
import { NO_STORE, questionErrorResponse } from "@/ee/ai/questions/http";

export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "analytics:read");
    return NextResponse.json(await listSavedQuestions(access), { headers: NO_STORE });
  } catch (error) {
    return questionErrorResponse(error);
  }
}

/** {question, query, shared?}: the query is validated again. */
export async function POST(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "analytics:read");
    return NextResponse.json(await createSavedQuestion(access, await readJsonBody(request)), { status: 201, headers: NO_STORE });
  } catch (error) {
    return questionErrorResponse(error);
  }
}
