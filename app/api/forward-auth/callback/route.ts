import { NextRequest, NextResponse } from "next/server";
import { redeemExchangeCode } from "@/src/lib/models/forward-auth";
import {
  FORWARD_AUTH_COOKIE_NAME,
  LEGACY_FORWARD_AUTH_COOKIE_NAME,
  resolveTrustedForwardAuthAudience,
} from "@/src/lib/forward-auth-trust";

const COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days

/**
 * Forward auth callback — redeems an exchange code and sets the session cookie.
 * Caddy routes /.ingressi-auth/callback (and the legacy /.cpm-auth/callback)
 * on proxied domains to this endpoint.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  if (!code) {
    return new NextResponse("Missing code parameter", { status: 400 });
  }

  // The public Next.js origin may be reachable directly, so forwarded headers
  // are accepted only with the proof injected by the generated Caddy route,
  // and only for the proxy host that route belongs to.
  const audience = await resolveTrustedForwardAuthAudience(request.headers);
  if (!audience) {
    return new NextResponse(
      "Invalid or expired authorization code. Please try logging in again.",
      { status: 401 }
    );
  }

  let result: Awaited<ReturnType<typeof redeemExchangeCode>>;
  try {
    result = await redeemExchangeCode(code, audience);
  } catch {
    // High availability shared state cannot be reached.
    return new NextResponse("Sign-in is temporarily unavailable. Please try again shortly.", { status: 503, headers: { "Retry-After": "5" } });
  }
  if (!result) {
    return new NextResponse(
      "Invalid or expired authorization code. Please try logging in again.",
      { status: 401 }
    );
  }

  // Redirect back to original URL with the session cookie set
  const response = NextResponse.redirect(result.redirectUri, 302);

  response.cookies.set(FORWARD_AUTH_COOKIE_NAME, result.rawSessionToken, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: COOKIE_MAX_AGE
  });
  // A session cookie under the pre-rename name would otherwise keep being
  // sent next to the new one until it expires.
  if (request.cookies.has(LEGACY_FORWARD_AUTH_COOKIE_NAME)) {
    response.cookies.set(LEGACY_FORWARD_AUTH_COOKIE_NAME, "", {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 0
    });
  }

  return response;
}
