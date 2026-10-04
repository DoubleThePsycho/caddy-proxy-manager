// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { NO_STORE, parseRouteId } from "@/ee/monetization/http";
import { CONSUMER_NOT_FOUND, getConsumer } from "@/ee/monetization/consumers";
import { resumeConsumer } from "@/ee/monetization/postpaid";

type Params = { params: Promise<{ id: string }> };

/** Ends a postpaid consumer's suspension (after a dispute, say). Needs the api_monetization feature. */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "monetization:write");
    const id = parseRouteId((await params).id, CONSUMER_NOT_FOUND);
    await resumeConsumer(id, userId);
    return NextResponse.json(await getConsumer(id), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
