// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { createDirectory, listDirectories } from "@/ee/ldap/directories";
import { NO_STORE, readJsonBody } from "@/ee/ldap/http";

/** LDAP / Active Directory directories. Readable without a license; the service account password is never returned. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "ldap:read");
    return NextResponse.json(await listDirectories(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "ldap:write");
    const directory = await createDirectory(await readJsonBody(request), userId);
    return NextResponse.json(directory, { status: 201, headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
