// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { deleteProvider, getProvider, updateProvider } from "@/ee/saml/providers";
import { NO_STORE, parseProviderId, readJsonBody } from "@/ee/saml/http";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "sso:read");
    return NextResponse.json(await getProvider(parseProviderId((await params).id)), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "sso:write");
    const id = parseProviderId((await params).id);
    return NextResponse.json(await updateProvider(id, await readJsonBody(request), userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Deleting never needs a license; the provider's account links and group mappings are deleted with it. */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "sso:write");
    await deleteProvider(parseProviderId((await params).id), userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
