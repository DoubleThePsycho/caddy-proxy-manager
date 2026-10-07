import { type NextRequest, NextResponse } from "next/server";
import { getAuth } from "./auth-server";
import { getUserById } from "./models/user";
import { MFA_SETUP_PATH, mfaEnrolmentRequired } from "./mfa";
import { can, permissionDeniedMessage, type Access, type Permission } from "./permissions";
import { ApiClientError } from "./api-errors";
import { accessForUser } from "@/ee/custom-roles/access";
import { getSessionSignInMethod, isPortalReusableSignInMethod, touchSessionLastSeen } from "./models/sessions";

export type Session = {
  user: {
    id: string;
    email: string;
    name: string | null;
    role: string;
    /** The user's custom role (ee/custom-roles), or null for a built-in role. */
    customRoleId?: number | null;
    provider?: string;
    image?: string | null;
  };
};

/** A session that passed requirePermission, with what the user may do. */
export type PermissionSession = Session & { access: Access };

/** Thrown by requirePermission and requireAdmin (403); the message is safe to show. */
export class PermissionDeniedError extends ApiClientError {
  constructor(message: string) {
    super(message, 403);
    this.name = "PermissionDeniedError";
  }
}

/**
 * Get the current session, optionally from a specific request.
 *
 * - `auth()` — uses `headers()` from next/headers (server components, route handlers)
 * - `auth(req)` — uses request headers (middleware)
 *
 * Returns `Session | null`. The user's role is always fetched fresh from the database
 * so that role changes (e.g. demotion) take effect immediately.
 */
export async function auth(req?: NextRequest): Promise<Session | null> {
  const hdrs = req
    ? req.headers
    : (await import("next/headers")).headers();

  // headers() in Next.js 15+ returns a Promise
  const resolvedHeaders = hdrs instanceof Promise ? await hdrs : hdrs;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let betterAuthSession: any;
  try {
    betterAuthSession = await getAuth().api.getSession({
      headers: resolvedHeaders,
    });
  } catch {
    return null;
  }

  if (!betterAuthSession?.user) {
    return null;
  }

  const baUser = betterAuthSession.user as {
    id: string | number;
    name?: string | null;
    email: string;
    image?: string | null;
    role?: string;
    provider?: string;
    status?: string;
    avatarUrl?: string | null;
    subject?: string;
  };
  const userId = typeof baUser.id === "string" ? Number(baUser.id) : baUser.id;

  // Always fetch current role/status from database to reflect changes immediately
  const currentUser = await getUserById(userId);
  if (!currentUser || currentUser.status !== "active") {
    return null;
  }

  // "Last seen" on Profile and in the users API, written at most once a minute.
  const baSession = betterAuthSession.session as { id?: string | number; updatedAt?: string | Date } | undefined;
  if (baSession?.id != null) await touchSessionLastSeen(Number(baSession.id), baSession.updatedAt);

  return {
    user: {
      id: String(currentUser.id),
      email: currentUser.email,
      name: currentUser.name,
      role: currentUser.role,
      customRoleId: currentUser.customRoleId,
      provider: currentUser.provider || baUser.provider,
      image: currentUser.avatarUrl ?? (baUser.avatarUrl as string | null | undefined) ?? null,
    },
  };
}

/**
 * Alias for auth() — get the current session on the server.
 */
export async function getSession(): Promise<Session | null> {
  return auth();
}

/**
 * Returns the DB id of the caller's current better-auth session, or null when
 * there is no session-cookie auth (e.g. a Bearer-token API call). Used to mark
 * the "current" session and to exclude it from "revoke other sessions".
 */
export async function getCurrentSessionId(req?: NextRequest): Promise<number | null> {
  return (await getCurrentSessionInfo(req))?.id ?? null;
}

/**
 * The caller's current better-auth session id and creation time, or null when
 * there is no session-cookie auth. The creation time tells how recently the
 * user actually signed in (it does not move when the session is refreshed).
 */
export async function getCurrentSessionInfo(
  req?: NextRequest
): Promise<{ id: number; createdAt: Date } | null> {
  const hdrs = req ? req.headers : (await import("next/headers")).headers();
  const resolvedHeaders = hdrs instanceof Promise ? await hdrs : hdrs;
  try {
    const result = await getAuth().api.getSession({ headers: resolvedHeaders });
    const session = result?.session;
    if (session?.id == null) return null;
    return { id: Number(session.id), createdAt: new Date(session.createdAt) };
  } catch {
    return null;
  }
}

/**
 * Whether the forward-auth portal may sign the caller in to a protected app
 * with their dashboard session: only when an identity provider created that
 * session (OIDC, SAML or LDAP sign-in). Single sign-on across apps then comes
 * from the customer's identity provider; a password or passkey session (and
 * one from before the sign-in method was recorded) is not reused, and the
 * user signs in at the portal instead.
 */
export async function portalMayReuseSession(req?: NextRequest): Promise<boolean> {
  const info = await getCurrentSessionInfo(req);
  if (!info) return false;
  try {
    return isPortalReusableSignInMethod(await getSessionSignInMethod(info.id));
  } catch {
    return false;
  }
}

/**
 * Require authentication. Redirects to /login if not authenticated, and to
 * the MFA setup page when the MFA policy's grace period for the account is
 * over and it has not set up MFA (src/lib/mfa.ts): such a session can only
 * set it up. auth() itself does not apply the MFA policy, so the forward-auth
 * portal, which uses the dashboard session, is unaffected.
 */
export async function requireUser(): Promise<Session> {
  const session = await auth();
  if (!session?.user) {
    const { redirect } = await import("next/navigation");
    redirect("/login");
    throw new Error("Redirecting to login"); // TypeScript doesn't know redirect() never returns
  }
  if (await mfaEnrolmentRequired(Number(session.user.id))) {
    const { redirect } = await import("next/navigation");
    redirect(MFA_SETUP_PATH);
    throw new Error("Redirecting to MFA setup");
  }
  return session;
}

/** What the session's user may do (built-in role or custom role). Never checks the license. */
export async function getSessionAccess(session: Session): Promise<Access> {
  return await accessForUser({
    id: Number(session.user.id),
    role: session.user.role,
    customRoleId: session.user.customRoleId ?? null,
  });
}

/**
 * Require one permission from the catalogue (src/lib/permissions.ts).
 * Administrators hold every permission; built-in user and viewer roles hold
 * none; a custom role holds what it lists. A role's tag scope is not checked
 * here: callers that touch a proxy host, L4 host or certificate apply it with
 * the helpers in src/lib/access-scope.ts.
 */
export async function requirePermission(permission: Permission): Promise<PermissionSession> {
  const session = await requireUser();
  const access = await getSessionAccess(session);
  if (!can(access, permission)) {
    throw new PermissionDeniedError(permissionDeniedMessage(access, permission));
  }
  return { ...session, access };
}

/**
 * Require the built-in admin role. Kept for the few paths that stay
 * administrator-only whatever a custom role holds (ee/docs/custom-roles.md
 * lists them).
 */
export async function requireAdmin(): Promise<Session> {
  const session = await requireUser();
  if (!(await getSessionAccess(session)).isAdmin) {
    throw new PermissionDeniedError("Administrator privileges required");
  }
  return session;
}

/**
 * Defense-in-depth CSRF check: verifies the Origin header matches the Host.
 * Returns a 403 response if the origin is present and mismatched; otherwise null.
 * Browsers always include Origin on cross-origin requests, so a mismatch means
 * the request came from a different site.
 */
export function checkSameOrigin(request: NextRequest): NextResponse | null {
  const origin = request.headers.get("origin");
  // For mutating requests, require Origin header to be present.
  // Browsers always send Origin on cross-origin POST/PUT/DELETE.
  const method = request.method.toUpperCase();
  const isMutating = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  if (!origin) {
    // Allow non-mutating requests without Origin (normal browser behavior)
    if (!isMutating) return null;
    // For mutating requests, require Origin header
    return NextResponse.json({ error: "Forbidden: Origin header required" }, { status: 403 });
  }

  const host = request.headers.get("host");
  try {
    const originHost = new URL(origin).host;
    if (originHost === host) return null;
  } catch {
    // unparseable origin — treat as mismatch
  }
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}
