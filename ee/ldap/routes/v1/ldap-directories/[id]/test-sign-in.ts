// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { getClientIp } from "@/src/lib/client-ip";
import { testDirectorySignIn } from "@/ee/ldap/diagnostics";
import { NO_STORE, parseDirectoryId, readJsonBody } from "@/ee/ldap/http";

type Params = { params: Promise<{ id: string }> };

/** Checks a username and password against the directory without signing anyone in or changing any account. */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "ldap:write");
    const id = parseDirectoryId((await params).id);
    const result = await testDirectorySignIn(id, await readJsonBody(request), userId, getClientIp(request.headers));
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
