// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, requireApiPermission } from "@/src/lib/api-auth";
import { createScimToken, listScimTokens } from "@/ee/scim/tokens";
import { NO_STORE, readJsonBody } from "@/ee/scim/rest";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "scim:read");
    return NextResponse.json(await listScimTokens(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** The token is in the response once and never again. */
export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "scim:write");
    const { token, rawToken } = await createScimToken(await readJsonBody(request), userId);
    return NextResponse.json({ ...token, token: rawToken }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
