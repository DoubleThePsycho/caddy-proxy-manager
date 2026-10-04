// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { createProvider, listProviders } from "@/ee/saml/providers";
import { NO_STORE, readJsonBody } from "@/ee/saml/http";

/** SAML identity providers. Readable without a license; the SP private key is never returned. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "sso:read");
    return NextResponse.json(await listProviders(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "sso:write");
    const provider = await createProvider(await readJsonBody(request), userId);
    return NextResponse.json(provider, { status: 201, headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
