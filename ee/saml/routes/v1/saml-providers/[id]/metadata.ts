// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { getProviderMetadata } from "@/ee/saml/providers";
import { parseProviderId } from "@/ee/saml/http";

/**
 * The SP metadata XML of a provider, for the identity provider. The same
 * document is public at
 * /api/auth/saml/metadata/{id} (it holds no secret).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireApiPermission(request, "sso:read");
    const xml = await getProviderMetadata(parseProviderId((await params).id));
    return new NextResponse(xml, {
      headers: {
        "Content-Type": "application/samlmetadata+xml; charset=utf-8",
        "Content-Disposition": "attachment; filename=\"saml-sp-metadata.xml\"",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
