import { and, eq, inArray, ne } from "drizzle-orm";
import { desc, first } from "@/src/lib/db/ops";
import { appDb, nowIso } from "../db";
import { sessions } from "../db/schema";
import { logAuditEvent } from "../audit";
import { parseUserAgent, type DeviceInfo } from "../user-agent";
import { lookupIpLocation, type IpLocation } from "../geoip-lookup";
import type { SignInMethod } from "../sign-in-activity";

/**
 * Active management-UI session for a user, as shown in the profile's
 * "Active sessions" view. (Forward-auth cookie sessions are tracked
 * separately and are not management-UI sessions.)
 */
export interface UserSession {
  id: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * A session as Profile, the users API and the sessions API show it. The
 * device is read from the User-Agent and the place looked up in the GeoLite2
 * databases from the address the session signed in from, every time it is
 * shown: neither is stored, the session row keeps only what Better Auth
 * stores (address and User-Agent).
 */
export interface SessionView extends UserSession {
  /** The session the request came with. */
  current: boolean;
  /** When the session was created: the sign-in. */
  signedInAt: string;
  /** The last request the session made, to the minute (updatedAt). */
  lastSeenAt: string;
  device: DeviceInfo;
  /** Country and network of ipAddress; null when unknown. */
  location: IpLocation | null;
}

/** How often a session's last-seen time is written while it is used. */
export const LAST_SEEN_RESOLUTION_MS = 60_000;

function isActive(expiresAt: string, now: number): boolean {
  const exp = new Date(expiresAt).getTime();
  return Number.isNaN(exp) || exp > now;
}

/** List a user's non-expired sessions, newest first. */
export async function listUserSessions(userId: number): Promise<UserSession[]> {
  const now = Date.now();
  const rows = await appDb
    .select({
      id: sessions.id,
      createdAt: sessions.createdAt,
      updatedAt: sessions.updatedAt,
      expiresAt: sessions.expiresAt,
      ipAddress: sessions.ipAddress,
      userAgent: sessions.userAgent,
    })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    // Same-time sessions in a stable order (the sort below keeps it).
    .orderBy(desc(sessions.createdAt), desc(sessions.id));

  return rows
    .filter((r) => isActive(r.expiresAt, now))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/** A user's non-expired sessions with device, place and times; the current one first. */
export async function describeUserSessions(userId: number, currentSessionId: number | null): Promise<SessionView[]> {
  const list = await listUserSessions(userId);
  const views = await Promise.all(list.map(async (session) => ({
    ...session,
    current: session.id === currentSessionId,
    signedInAt: session.createdAt,
    lastSeenAt: session.updatedAt,
    device: parseUserAgent(session.userAgent),
    location: await lookupIpLocation(session.ipAddress).catch(() => null),
  })));
  return views.sort((a, b) => Number(b.current) - Number(a.current));
}

/**
 * Records that a session was used now, at most once a minute. Better Auth
 * moves updatedAt only when it extends a session (once a day); its refresh
 * rule reads expiresAt, never updatedAt, so moving it here changes nothing
 * else.
 */
export async function touchSessionLastSeen(sessionId: number, updatedAt: string | Date | null | undefined): Promise<void> {
  const last = updatedAt ? new Date(updatedAt).getTime() : 0;
  if (Number.isFinite(last) && Date.now() - last < LAST_SEEN_RESOLUTION_MS) return;
  try {
    await appDb.update(sessions).set({ updatedAt: nowIso() }).where(eq(sessions.id, sessionId));
  } catch {
    // Bookkeeping only; never fail a request over it.
  }
}

/**
 * The sign-in methods whose dashboard session the forward-auth portal reuses:
 * an identity provider signed the user in (OIDC, SAML, an LDAP directory).
 * A password or passkey session is one Ingressi itself authenticated; the
 * portal asks that user to sign in at the portal instead.
 */
const PORTAL_REUSABLE_SIGN_IN_METHODS: ReadonlySet<string> = new Set<SignInMethod>(["sso", "saml", "ldap"]);

export function isPortalReusableSignInMethod(method: string | null | undefined): boolean {
  return typeof method === "string" && PORTAL_REUSABLE_SIGN_IN_METHODS.has(method);
}

/** Records how the sign-in that created the session was made (written once, when the sign-in completes). */
export async function setSessionSignInMethod(sessionId: number, method: SignInMethod | null): Promise<void> {
  await appDb.update(sessions).set({ signInMethod: method }).where(eq(sessions.id, sessionId));
}

/** How the sign-in that created the session was made; null when unknown (sessions from before this was recorded). */
export async function getSessionSignInMethod(sessionId: number): Promise<string | null> {
  const row = await first(
    appDb.select({ signInMethod: sessions.signInMethod }).from(sessions).where(eq(sessions.id, sessionId)).limit(1)
  );
  return row?.signInMethod ?? null;
}

/**
 * Revoke a single session, but only if it belongs to the given user.
 * Returns false if no such session exists for that user (so callers can 404).
 */
export async function revokeUserSession(userId: number, sessionId: number): Promise<boolean> {
  const [existing] = await appDb
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
  if (!existing) return false;
  await appDb.delete(sessions).where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
  return true;
}

/**
 * Revoke all of a user's sessions except `exceptSessionId` (typically the
 * caller's current session). Returns the number of sessions revoked.
 */
export async function revokeOtherUserSessions(
  userId: number,
  exceptSessionId: number | null
): Promise<number> {
  const rows = await appDb
    .select({ id: sessions.id })
    .from(sessions)
    .where(exceptSessionId === null
      ? eq(sessions.userId, userId)
      : and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId)));
  const toRevoke = rows.map((r) => r.id);
  if (toRevoke.length > 0) {
    await appDb.delete(sessions).where(and(eq(sessions.userId, userId), inArray(sessions.id, toRevoke)));
  }
  return toRevoke.length;
}

/** Who signs a session out: the account itself, or someone with users:write. */
export type SessionActor = { actorUserId: number; userId: number };

/** Signs out one session of `userId`, recorded in the audit log. False when the user has no such session. */
export async function signOutSession({ actorUserId, userId }: SessionActor, sessionId: number): Promise<boolean> {
  const revoked = await revokeUserSession(userId, sessionId);
  if (revoked) {
    await logAuditEvent({
      userId: actorUserId,
      action: "session_revoked",
      entityType: "user",
      entityId: userId,
      summary: actorUserId === userId
        ? "Signed out one of their own sessions"
        : `Signed out a session of user ${userId}`,
      data: { sessionId },
    });
  }
  return revoked;
}

/**
 * Signs out every session of `userId` except `exceptSessionId` (the caller's
 * own, when they sign out their other sessions), recorded in the audit log.
 * Returns how many were signed out.
 */
export async function signOutSessions({ actorUserId, userId }: SessionActor, exceptSessionId: number | null): Promise<number> {
  const revoked = await revokeOtherUserSessions(userId, exceptSessionId);
  if (revoked > 0) {
    await logAuditEvent({
      userId: actorUserId,
      action: "sessions_revoked",
      entityType: "user",
      entityId: userId,
      summary: actorUserId === userId
        ? `Signed out ${revoked} of their other session(s)`
        : `Signed out ${revoked} session(s) of user ${userId}`,
      data: { count: revoked, keptCurrent: exceptSessionId !== null },
    });
  }
  return revoked;
}
