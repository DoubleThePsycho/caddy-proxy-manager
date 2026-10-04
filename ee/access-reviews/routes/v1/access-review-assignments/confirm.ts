// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, requireApiUser } from "@/src/lib/api-auth";
import { confirmDecisions } from "@/ee/access-reviews/decisions";
import { NO_STORE, readJsonBody } from "@/ee/access-reviews/http";

/** Confirms the caller's draft decisions in one review ({campaignId}) and applies the revocations. */
export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiUser(request);
    return NextResponse.json(await confirmDecisions(userId, await readJsonBody(request)), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
