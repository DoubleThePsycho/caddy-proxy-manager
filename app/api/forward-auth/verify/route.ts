import { NextRequest, NextResponse } from "next/server";
import {
  authorizeForwardAuthRequest,
  validateForwardAuthSession,
} from "@/src/lib/models/forward-auth";
import {
  FORWARD_AUTH_COOKIE_NAME,
  FORWARD_AUTH_IDENTITY_HEADERS,
  FORWARD_AUTH_PORTAL_TARGET_HEADER,
  LEGACY_FORWARD_AUTH_COOKIE_NAME,
  LEGACY_FORWARD_AUTH_IDENTITY_HEADERS,
  getForwardAuthPortalTarget,
  resolveTrustedForwardAuthAudience,
} from "@/src/lib/forward-auth-trust";

/**
 * A 401/403 for Caddy, which answers it with a redirect to the portal.  The
 * portal target header carries the protected URL encoded for the portal's
 * query string.
 */
function deny(request: NextRequest, status: 401 | 403): NextResponse {
  const target = getForwardAuthPortalTarget(request.headers);
  return new NextResponse(status === 403 ? "Forbidden" : null, {
    status,
    headers: target ? { [FORWARD_AUTH_PORTAL_TARGET_HEADER]: target } : undefined,
  });
}

/**
 * Forward auth verify endpoint — called by Caddy as a subrequest.
 * Returns 200 + user headers on success, 401/403 on failure.
 */
export async function GET(request: NextRequest) {
  // Never trust X-Forwarded-* from a client reaching Next.js directly.  Only
  // generated Caddy routes know the purpose-derived proof value, and the
  // audience must be the proxy host whose route issued the subrequest.
  const audience = await resolveTrustedForwardAuthAudience(request.headers);
  if (!audience) {
    return deny(request, 401);
  }

  const token =
    request.cookies.get(FORWARD_AUTH_COOKIE_NAME)?.value ??
    request.cookies.get(LEGACY_FORWARD_AUTH_COOKIE_NAME)?.value;
  if (!token) {
    return deny(request, 401);
  }

  let session: Awaited<ReturnType<typeof validateForwardAuthSession>>;
  try {
    session = await validateForwardAuthSession(token, audience);
  } catch {
    // High availability shared state cannot be reached: refuse, never let through.
    return new NextResponse("Sign-in is temporarily unavailable", { status: 503, headers: { "Retry-After": "5" } });
  }
  if (!session) {
    return deny(request, 401);
  }

  // 401 for a user that is gone or not active, 403 without access to the
  // host (checkHostAccess); otherwise the user and the groups for the header,
  // with the user read once.
  const verdict = await authorizeForwardAuthRequest(session.userId, audience.proxyHostId);
  if (verdict.status !== 200) {
    return deny(request, verdict.status);
  }
  const { user, groups } = verdict;
  const groupNames = groups.map((g) => g.name).join(",");

  // Return 200 with user info headers that Caddy will copy to upstream.
  // X-Ingressi-User is the sign-in username, or the email address for an
  // account without one: no other account can hold either (see
  // sign-in-names.ts). The display name is not unique, since users, OAuth
  // providers and ADMIN_USERNAME choose it, so an upstream trusting it could
  // be told one user is another. The legacy X-CPM-* names carry the same
  // values for upstreams configured before the rename.
  const identity = {
    user: user.username ?? user.email,
    email: user.email,
    groups: groupNames,
    userId: String(user.id)
  };
  const headers = new Headers();
  for (const names of [FORWARD_AUTH_IDENTITY_HEADERS, LEGACY_FORWARD_AUTH_IDENTITY_HEADERS]) {
    for (const [field, value] of Object.entries(identity)) {
      headers.set(names[field as keyof typeof identity], value);
    }
  }
  return new NextResponse(null, { status: 200, headers });
}
