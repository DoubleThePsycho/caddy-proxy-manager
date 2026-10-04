// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, requireApiUser } from "@/src/lib/api-auth";
import { setDraftDecision } from "@/ee/access-reviews/decisions";
import { NO_STORE, parseRouteId, readJsonBody } from "@/ee/access-reviews/http";

type Params = { params: Promise<{ id: string }> };

/** Draft decision on a review item: {decision: "keep" | "revoke" | null, comment?}. Reviewers only; never one's own access. */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiUser(request);
    const id = parseRouteId((await params).id, "Review item not found");
    return NextResponse.json(await setDraftDecision(userId, id, await readJsonBody(request)), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
