// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { NO_STORE, parseRouteId } from "@/ee/monetization/http";
import { CONSUMER_NOT_FOUND, createConsumerKey, listConsumerKeys } from "@/ee/monetization/consumers";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "monetization:read");
    return NextResponse.json(await listConsumerKeys(parseRouteId((await params).id, CONSUMER_NOT_FOUND)), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** The key is in the response once (rawKey); only its hash and prefix are stored. */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "monetization:write");
    const id = parseRouteId((await params).id, CONSUMER_NOT_FOUND);
    const text = await request.text();
    let body: unknown = {};
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        return NextResponse.json({ error: "Request body must be JSON" }, { status: 400 });
      }
    }
    return NextResponse.json(await createConsumerKey(id, body, userId), { status: 201, headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
