// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { testDirectory } from "@/ee/ldap/diagnostics";
import { NO_STORE, parseDirectoryId } from "@/ee/ldap/http";

type Params = { params: Promise<{ id: string }> };

/** Connects, binds as the service account and reads the user search base. */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "ldap:write");
    return NextResponse.json(await testDirectory(parseDirectoryId((await params).id), userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
