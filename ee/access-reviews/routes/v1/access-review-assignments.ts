// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, requireApiUser } from "@/src/lib/api-auth";
import { listAssignments } from "@/ee/access-reviews/decisions";
import { NO_STORE } from "@/ee/access-reviews/http";

/**
 * The open access reviews the caller is a reviewer of, with their items.
 * Being named as a reviewer is the authorization; no permission is needed.
 */
export async function GET(request: NextRequest) {
  try {
    const { userId } = await requireApiUser(request);
    return NextResponse.json(await listAssignments(userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
