// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission } from "@/src/lib/api-auth";
import { readJsonBody } from "@/ee/alerting/http";
import { askQuestion } from "@/ee/ai/questions/ask";
import { NO_STORE, questionErrorResponse } from "@/ee/ai/questions/http";

/**
 * Asks a question about traffic in plain language ({question}). The AI
 * provider turns it into a structured query that is validated and run here
 * with the caller's scope. 502 when the provider fails, 429 over the limits.
 */
export async function POST(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "analytics:read");
    return NextResponse.json(await askQuestion(access, await readJsonBody(request)), { headers: NO_STORE });
  } catch (error) {
    return questionErrorResponse(error);
  }
}
