// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { NO_STORE, readJsonBody } from "@/ee/alerting/http";
import { getQuestionSettings, saveQuestionSettings } from "@/ee/ai/questions/settings";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "ai:read");
    return NextResponse.json(await getQuestionSettings(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Partial. Needs the AI analyst license unless it only turns settings off. */
export async function PUT(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "ai:write");
    return NextResponse.json(await saveQuestionSettings(await readJsonBody(request), userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
