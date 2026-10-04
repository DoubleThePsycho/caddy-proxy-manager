import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { listOAuthProviders, createOAuthProvider } from "@/src/lib/models/oauth-providers";
import { oauthCallbackUrl, toOAuthProviderView, type OAuthProviderView } from "@/src/lib/oauth-provider-view";
import { createAuditEvent } from "@/src/lib/models/audit";
import { reloadOAuthProviders } from "@/src/lib/auth-server";
import { config } from "@/src/lib/config";

const PRIVATE_RESPONSE_HEADERS = { "Cache-Control": "no-store" };

function redactClientId(provider: OAuthProviderView) {
  const clientId = provider.clientId;
  return {
    ...provider,
    clientId: clientId.length > 4 ? "••••" + clientId.slice(-4) : "••••",
    // What the operator must register as the redirect URI at the IdP.
    callbackUrl: oauthCallbackUrl(config.baseUrl, provider.id),
  };
}

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "sso:read");
    const providers = await listOAuthProviders();
    return NextResponse.json(providers.map(redactClientId), {
      headers: PRIVATE_RESPONSE_HEADERS,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "sso:write");
    const body = await request.json();

    if (!body.name || typeof body.name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (!body.clientId || typeof body.clientId !== "string") {
      return NextResponse.json({ error: "clientId is required" }, { status: 400 });
    }
    if (!body.clientSecret || typeof body.clientSecret !== "string") {
      return NextResponse.json({ error: "clientSecret is required" }, { status: 400 });
    }

    const provider = await createOAuthProvider({
      name: body.name,
      type: body.type ?? "oidc",
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      issuer: body.issuer ?? null,
      authorizationUrl: body.authorizationUrl ?? null,
      tokenUrl: body.tokenUrl ?? null,
      userinfoUrl: body.userinfoUrl ?? null,
      scopes: body.scopes ?? "openid email profile",
      autoLink: body.autoLink ?? false,
      source: "ui",
    });

    await reloadOAuthProviders();

    await createAuditEvent({
      userId,
      action: "create",
      entityType: "oauth_provider",
      entityId: null,
      summary: `Created OAuth provider "${provider.name}"`,
      data: JSON.stringify({ providerId: provider.id, name: provider.name, type: provider.type }),
    });

    return NextResponse.json(redactClientId(toOAuthProviderView(provider)), {
      status: 201,
      headers: PRIVATE_RESPONSE_HEADERS,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
