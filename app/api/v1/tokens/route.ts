import { NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse, getApiAccess } from "@/src/lib/api-auth";
import {
  createApiToken,
  expiryFromPreset,
  isTokenExpiryPreset,
  listApiTokens,
  listAllApiTokens,
  TOKEN_EXPIRY_PRESETS,
} from "@/src/lib/models/api-tokens";
import { logAuditEvent } from "@/src/lib/audit";

export async function GET(request: NextRequest) {
  try {
    // A token with scopes is refused: they do not cover the owner's tokens.
    const auth = await requireApiUser(request);
    // Every user's tokens for administrators only, whatever a custom role holds.
    const tokens = (await getApiAccess(auth)).isAdmin ? await listAllApiTokens() : await listApiTokens(auth.userId);
    return NextResponse.json(tokens);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId, authMethod } = await requireApiUser(request);

    // Credential creation requires an interactive, cookie-authenticated session.
    // Otherwise a stolen (possibly short-lived) bearer token could mint a new,
    // non-expiring token and survive revocation or expiry of the original.
    if (authMethod !== "session") {
      return NextResponse.json(
        { error: "API tokens can only be created from an authenticated session" },
        { status: 403 }
      );
    }

    const body = await request.json();

    if (!body.name || typeof body.name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    // Validate expires_at before passing to createApiToken
    if (body.expires_at !== undefined && body.expires_at !== null && typeof body.expires_at !== "string") {
      return NextResponse.json({ error: "expires_at must be a string (ISO 8601 date)" }, { status: 400 });
    }
    // A preset instead of a date: 30, 90 or 365 days from now, or never.
    if (body.expiresIn !== undefined && body.expiresIn !== null && !isTokenExpiryPreset(body.expiresIn)) {
      return NextResponse.json({ error: `expiresIn must be one of ${TOKEN_EXPIRY_PRESETS.join(", ")}` }, { status: 400 });
    }
    if (body.expiresIn != null && body.expires_at != null) {
      return NextResponse.json({ error: "Give expires_at or expiresIn, not both" }, { status: 400 });
    }
    const expiresAt = body.expiresIn != null ? expiryFromPreset(body.expiresIn) ?? undefined : body.expires_at ?? undefined;

    // Scopes are checked against what the caller's role holds now (400 otherwise).
    const result = body.scopes === undefined
      ? await createApiToken(body.name, userId, expiresAt)
      : await createApiToken(body.name, userId, expiresAt, { scopes: body.scopes });
    await logAuditEvent({
      userId,
      action: "api_token_created",
      entityType: "api_token",
      entityId: result.token.id,
      summary: `Created API token "${result.token.name}"`,
      data: { scopes: result.token.scopes ?? null, expiresAt: result.token.expiresAt ?? null },
    });
    return NextResponse.json({ token: result.token, raw_token: result.rawToken }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
