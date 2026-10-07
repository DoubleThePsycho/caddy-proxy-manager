import { NextRequest, NextResponse } from "next/server";
import { auth, portalMayReuseSession } from "@/src/lib/auth";
import { config } from "@/src/lib/config";
import { FORWARD_AUTH_CALLBACK_PATH } from "@/src/lib/forward-auth-trust";
import {
  createForwardAuthSession,
  createExchangeCode,
  checkHostAccess,
  consumeRedirectIntent
} from "@/src/lib/models/forward-auth";
import { logAuditEvent } from "@/src/lib/audit";

/**
 * Forward auth session login: signs the visitor in to the protected app with
 * their dashboard session. Only a session an identity provider created (OIDC,
 * SAML or LDAP sign-in) qualifies, so single sign-on across apps comes from
 * that provider; a password or passkey session gets 401 and the visitor signs
 * in at the portal. Called by the portal when it finds such a session
 * (e.g. after the OAuth return).
 */
export async function POST(request: NextRequest) {
  try {
    // CSRF: verify the request originates from the dashboard portal
    const origin = request.headers.get("origin");
    const baseOrigin = new URL(config.baseUrl).origin;
    if (!origin || origin !== baseOrigin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    if (!(await portalMayReuseSession())) {
      return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
    }

    const body = await request.json();
    const rid = typeof body.rid === "string" ? body.rid : "";

    if (!rid) {
      return NextResponse.json({ error: "Missing redirect intent" }, { status: 400 });
    }

    // Consume the redirect intent — returns the server-stored redirect URI
    const intent = await consumeRedirectIntent(rid);
    if (!intent) {
      return NextResponse.json({ error: "Invalid or expired redirect intent. Please try again." }, { status: 400 });
    }

    const targetUrl = new URL(intent.redirectUri);
    const userId = Number(session.user.id);

    // Authorize the concrete proxy host captured by the one-time intent.
    const hasAccess = await checkHostAccess(userId, intent.audience.proxyHostId);
    if (!hasAccess) {
      await logAuditEvent({
        userId,
        action: "forward_auth_access_denied",
        entityType: "proxy_host",
        summary: `Forward auth access denied for user ${session.user.email} to host ${targetUrl.hostname}`
      });
      return NextResponse.json(
        { error: "You do not have access to this application." },
        { status: 403 }
      );
    }

    // Create forward auth session and exchange code
    const { session: faSession } = await createForwardAuthSession(userId, intent.audience);
    const { rawCode } = await createExchangeCode(
      faSession.id,
      intent.redirectUri,
      intent.audience,
    );

    await logAuditEvent({
      userId,
      action: "forward_auth_login",
      entityType: "user",
      entityId: userId,
      summary: `Forward auth login (session) for user ${session.user.email} to ${targetUrl.hostname}`
    });

    const callbackUrl = new URL(FORWARD_AUTH_CALLBACK_PATH, intent.audience.origin);
    callbackUrl.searchParams.set("code", rawCode);

    return NextResponse.json({ redirectTo: callbackUrl.toString() });
  } catch (error) {
    console.error("Forward auth session login error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
