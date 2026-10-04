// SPDX-License-Identifier: Elastic-2.0
/**
 * Responses of the question endpoints: apiErrorResponse, plus 502 when the
 * AI provider failed to interpret a question (the message is
 * application-authored).
 */
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/src/lib/api-auth";
import { AiQuestionError } from "./ask";

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export function questionErrorResponse(error: unknown): NextResponse {
  if (error instanceof AiQuestionError) return NextResponse.json({ error: error.message }, { status: 502, headers: NO_STORE });
  return apiErrorResponse(error);
}
