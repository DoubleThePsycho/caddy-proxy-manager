// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { deleteDirectory, getDirectory, updateDirectory } from "@/ee/ldap/directories";
import { NO_STORE, parseDirectoryId, readJsonBody } from "@/ee/ldap/http";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "ldap:read");
    return NextResponse.json(await getDirectory(parseDirectoryId((await params).id)), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "ldap:write");
    const id = parseDirectoryId((await params).id);
    return NextResponse.json(await updateDirectory(id, await readJsonBody(request), userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Deleting never needs a license; the directory's account links are deleted with it. */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "ldap:write");
    await deleteDirectory(parseDirectoryId((await params).id), userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
