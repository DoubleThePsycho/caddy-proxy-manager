// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission } from "@/src/lib/api-auth";
import { parseRouteId } from "@/src/lib/analytics/http";
import { runSavedQuestion } from "@/ee/ai/questions/ask";
import { NO_STORE, questionErrorResponse } from "@/ee/ai/questions/http";

/** Re-runs a saved question with fresh data; the model is not asked to interpret it again. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { access } = await requireApiPermission(request, "analytics:read");
    return NextResponse.json(await runSavedQuestion(access, parseRouteId((await params).id, "Question")), { headers: NO_STORE });
  } catch (error) {
    return questionErrorResponse(error);
  }
}
