import { createHash, randomBytes } from "node:crypto";
import { appDb, nowIso, toIso } from "../db";
import { logAuditEvent } from "../audit";
import {
  forwardAuthAccess,
  groupMembers,
  groups,
  organizations,
  proxyHosts,
  users,
} from "../db/schema";
import { and, eq, inArray, or } from "drizzle-orm";
import { forwardAuthStateStore, type ForwardAuthSessionRecord } from "../forward-auth-state";
import {
  actorOrganizationId,
  assertActorReaches,
  organizationCondition,
  type OrganizationFilter,
} from "@/ee/multi-tenancy/scope";
import { assertGrantsInTenant } from "@/ee/multi-tenancy/guard";
import { hostMatchesPattern } from "../host-pattern-priority";
import { config } from "../config";
import { ApiValidationError } from "../api-errors";
import { asc, containsText, first } from "@/src/lib/db/ops";

const DEFAULT_SESSION_TTL = 7 * 24 * 60 * 60; // 7 days in seconds
const EXCHANGE_CODE_TTL = 60; // 60 seconds
const REDIRECT_INTENT_TTL = 10 * 60; // 10 minutes — covers login + OAuth flow time

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export type ForwardAuthAudience = {
  /** Exact normalized external origin: scheme + hostname + non-default port. */
  origin: string;
  /** Hostname without a port, used only for display/audit messages. */
  hostname: string;
  /** The concrete proxy-host record which authorized the wildcard/exact host. */
  proxyHostId: number;
};

/** Parse an http(s) URL without credentials, whatever its port. */
function parseForwardAuthUrlAnyPort(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Caddy routes by hostname only, so a non-default port is accepted only when
 * the operator declared it as an external forward-auth port.
 */
function isForwardAuthPortAllowed(parsed: URL): boolean {
  return !parsed.port || config.forwardAuthAllowedPorts.has(parsed.port);
}

function parseForwardAuthUrl(rawUrl: string): URL | null {
  const parsed = parseForwardAuthUrlAnyPort(rawUrl);
  return parsed && isForwardAuthPortAllowed(parsed) ? parsed : null;
}

// Ports reported in the current window, so each one is logged once per window.
// The cap bounds the log volume when clients probe many ports of a protected
// hostname; the window restarts hourly, so ports crowded out by such probing
// are still reported later.
let reportedDisallowedPorts = new Set<string>();
let reportWindowStartedAt = 0;
const MAX_REPORTED_DISALLOWED_PORTS = 32;
const DISALLOWED_PORT_REPORT_WINDOW_MS = 60 * 60 * 1000;

function reportDisallowedPort(hostname: string, port: string): void {
  const now = Date.now();
  if (now < reportWindowStartedAt || now - reportWindowStartedAt >= DISALLOWED_PORT_REPORT_WINDOW_MS) {
    reportedDisallowedPorts = new Set();
    reportWindowStartedAt = now;
  }
  if (
    reportedDisallowedPorts.has(port) ||
    reportedDisallowedPorts.size >= MAX_REPORTED_DISALLOWED_PORTS
  ) {
    return;
  }
  reportedDisallowedPorts.add(port);
  console.warn(
    `[forward-auth] Rejected ${hostname}:${port} because port ${port} is not listed in ` +
      `FORWARD_AUTH_ALLOWED_PORTS. If forward-auth protected sites are served on port ${port}, ` +
      `add it to FORWARD_AUTH_ALLOWED_PORTS (comma-separated) and recreate the web container (docker compose up -d).`
  );
}

function audienceMatchesUrl(audience: ForwardAuthAudience, parsed: URL): boolean {
  return (
    Number.isInteger(audience.proxyHostId) &&
    audience.proxyHostId > 0 &&
    audience.origin === parsed.origin &&
    audience.hostname === parsed.hostname.toLowerCase()
  );
}

// ── Redirect Intents ────────────────────────────────────────────────
// Store redirect URIs server-side so the client only holds an opaque ID.
// Intents, sessions and exchange codes live in the forward-auth state store
// (src/lib/forward-auth-state.ts): SQLite, or Redis/Valkey when high
// availability shared state is on.

export async function createRedirectIntent(redirectUri: string): Promise<string> {
  // Resolve and persist the concrete target now.  In particular, a wildcard
  // match is reduced to the exact origin the browser will visit and the one
  // proxy-host record that authorized it.
  const audience = await resolveForwardAuthAudience(redirectUri);
  if (!audience) throw new Error("Redirect URI is not a forward-auth target");

  const rid = randomBytes(16).toString("hex");
  const store = await forwardAuthStateStore();
  await store.createRedirectIntent({
    ridHash: hashToken(rid),
    proxyHostId: audience.proxyHostId,
    audienceOrigin: audience.origin,
    redirectUri,
    ttlSeconds: REDIRECT_INTENT_TTL,
  });
  return rid;
}

/**
 * Whether a redirect intent exists, is unconsumed and unexpired — without
 * claiming it.  Lets the login endpoint reject a bad intent before it spends
 * any effort on (or reveals anything about) the submitted credentials.
 */
export async function isRedirectIntentUsable(rid: string): Promise<boolean> {
  if (!rid) return false;
  return (await forwardAuthStateStore()).isRedirectIntentUsable(hashToken(rid));
}

export async function consumeRedirectIntent(
  rid: string
): Promise<{
  redirectUri: string;
  audience: ForwardAuthAudience;
} | null> {
  // Atomic claim: only succeeds if the intent exists, is unconsumed, and not
  // expired; it is gone afterwards.
  const intent = await (await forwardAuthStateStore()).claimRedirectIntent(hashToken(rid));
  if (!intent) return null;

  const parsed = parseForwardAuthUrl(intent.redirectUri);
  if (!parsed || !intent.audienceOrigin || !intent.proxyHostId) return null;

  const audience: ForwardAuthAudience = {
    origin: intent.audienceOrigin,
    hostname: parsed.hostname.toLowerCase(),
    proxyHostId: intent.proxyHostId,
  };
  if (!audienceMatchesUrl(audience, parsed)) return null;

  // Fail closed if the proxy-host mapping changed between creation and use.
  const currentAudience = await resolveForwardAuthAudience(intent.redirectUri);
  if (
    !currentAudience ||
    currentAudience.origin !== audience.origin ||
    currentAudience.proxyHostId !== audience.proxyHostId
  ) {
    return null;
  }

  return { redirectUri: intent.redirectUri, audience };
}

// ── Sessions ─────────────────────────────────────────────────────────

export type ForwardAuthSession = ForwardAuthSessionRecord;

export async function createForwardAuthSession(
  userId: number,
  audience: ForwardAuthAudience,
  ttlSeconds?: number
): Promise<{ rawToken: string; session: ForwardAuthSession }> {
  const parsedAudience = parseForwardAuthUrl(audience.origin);
  if (!parsedAudience || !audienceMatchesUrl(audience, parsedAudience)) {
    throw new Error("Invalid forward-auth audience");
  }

  const rawToken = randomBytes(32).toString("hex");
  const session = await (await forwardAuthStateStore()).createSession({
    userId,
    proxyHostId: audience.proxyHostId,
    audienceOrigin: audience.origin,
    tokenHash: hashToken(rawToken),
    ttlSeconds: ttlSeconds ?? DEFAULT_SESSION_TTL,
  });
  return { rawToken, session };
}

export async function validateForwardAuthSession(
  rawToken: string,
  audience: ForwardAuthAudience,
): Promise<{ sessionId: number; userId: number } | null> {
  const session = await (await forwardAuthStateStore()).findSessionByTokenHash(hashToken(rawToken));

  if (!session) return null;
  if (new Date(session.expiresAt) <= new Date()) return null;
  if (
    session.proxyHostId !== audience.proxyHostId ||
    session.audienceOrigin !== audience.origin
  ) {
    return null;
  }

  return { sessionId: session.id, userId: session.userId };
}

/** `organizationId` limits the list to sessions of one organisation's users (see listProxyHosts). */
export async function listForwardAuthSessions(organizationId?: OrganizationFilter): Promise<ForwardAuthSession[]> {
  const sessions = await (await forwardAuthStateStore()).listSessions();
  if (sessions.length === 0) return [];
  // Only sessions of existing users of the organisation asked for.
  const userIds = [...new Set(sessions.map((session) => session.userId))];
  const visible = new Set(
    (await appDb
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.id, userIds), organizationCondition(users.organizationId, organizationId))))
      .map((row) => row.id)
  );
  return sessions.filter((session) => visible.has(session.userId));
}

/** One session, expired or not; null when there is none. */
export async function getForwardAuthSession(id: number): Promise<ForwardAuthSession | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return (await forwardAuthStateStore()).getSession(id);
}

export async function deleteForwardAuthSession(id: number): Promise<void> {
  if (!Number.isSafeInteger(id) || id <= 0) return;
  await (await forwardAuthStateStore()).deleteSessions([id]);
}

export async function deleteUserForwardAuthSessions(userId: number): Promise<void> {
  await revokeForwardAuthSessionsOfUsers([userId]);
}

/**
 * Ends every forward-auth session of these users, on every node: a sign-out,
 * a disabled, deleted or deprovisioned account, a new password. Callers that
 * already deleted the SQLite rows in their own transaction call it after the
 * commit too, so a shared store (high availability) forgets them as well.
 */
export async function revokeForwardAuthSessionsOfUsers(userIds: number[]): Promise<number> {
  const ids = [...new Set(userIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (ids.length === 0) return 0;
  return (await forwardAuthStateStore()).deleteSessionsOfUsers(ids);
}

/**
 * After a change that can take access away (a user removed from a group, a
 * group deleted, a host's grants replaced, users or hosts moved between
 * organisations, a configuration restored): with a shared store (high
 * availability), ends the sessions of these users or hosts that this
 * database no longer allows, so that nodes whose copy of the database trails
 * this one refuse them at once as well. Without one, the verify endpoint
 * already checks access against this database on every request, and nothing
 * is deleted. `all` re-checks every session.
 */
export async function revokeForwardAuthSessionsWithoutAccess(
  filter: { userIds?: number[]; proxyHostIds?: number[]; all?: boolean }
): Promise<number> {
  const store = await forwardAuthStateStore();
  if (!store.revokesOnAccessChange) return 0;
  if (!filter.all && !filter.userIds?.length && !filter.proxyHostIds?.length) return 0;
  const sessions = filter.all
    ? await store.listSessions()
    : await store.listSessions({
        ...(filter.userIds?.length ? { userIds: filter.userIds } : {}),
        ...(filter.proxyHostIds?.length ? { proxyHostIds: filter.proxyHostIds } : {}),
      });
  const verdicts = new Map<string, Promise<boolean>>();
  const stale: number[] = [];
  for (const session of sessions) {
    const key = `${session.userId}:${session.proxyHostId}`;
    if (!verdicts.has(key)) verdicts.set(key, userMayStillPass(session.userId, session.proxyHostId));
    if (!(await verdicts.get(key))) stale.push(session.id);
  }
  return stale.length > 0 ? store.deleteSessions(stale) : 0;
}

/** The verify endpoint's checks that do not depend on the request: active user, access to the host. */
async function userMayStillPass(userId: number, proxyHostId: number): Promise<boolean> {
  return (await authorizeForwardAuthRequest(userId, proxyHostId)).status === 200;
}

/**
 * A deleted proxy host's sessions. With a shared store (high availability)
 * they are deleted on every node; the SQLite rows went with the host
 * (deleteProxyHost).
 */
export async function revokeForwardAuthSessionsOfDeletedHosts(proxyHostIds: number[]): Promise<number> {
  const store = await forwardAuthStateStore();
  if (!store.revokesOnAccessChange || proxyHostIds.length === 0) return 0;
  return store.deleteSessionsOfHosts(proxyHostIds);
}

// ── Exchange Codes ───────────────────────────────────────────────────

export async function createExchangeCode(
  sessionId: number,
  redirectUri: string,
  audience: ForwardAuthAudience,
): Promise<{ rawCode: string }> {
  const parsedRedirect = parseForwardAuthUrl(redirectUri);
  if (!parsedRedirect || !audienceMatchesUrl(audience, parsedRedirect)) {
    throw new Error("Invalid forward-auth audience");
  }

  const store = await forwardAuthStateStore();
  const session = await store.getSession(sessionId);
  if (
    !session ||
    session.proxyHostId !== audience.proxyHostId ||
    session.audienceOrigin !== audience.origin
  ) {
    throw new Error("Forward-auth session audience mismatch");
  }

  const rawCode = randomBytes(32).toString("hex");
  await store.createExchange({
    sessionId,
    proxyHostId: audience.proxyHostId,
    audienceOrigin: audience.origin,
    codeHash: hashToken(rawCode),
    redirectUri,
    ttlSeconds: EXCHANGE_CODE_TTL,
  });

  return { rawCode };
}

export async function redeemExchangeCode(
  rawCode: string,
  audience: ForwardAuthAudience,
): Promise<{ sessionId: number; redirectUri: string; rawSessionToken: string } | null> {
  const store = await forwardAuthStateStore();

  // Atomic claim: only succeeds if the exchange exists, is unused, not
  // expired and of this audience; it is gone afterwards.
  const exchange = await store.claimExchange({
    codeHash: hashToken(rawCode),
    proxyHostId: audience.proxyHostId,
    audienceOrigin: audience.origin,
  });
  if (!exchange) return null;

  const parsedRedirect = parseForwardAuthUrl(exchange.redirectUri);
  if (!parsedRedirect || !audienceMatchesUrl(audience, parsedRedirect)) return null;

  // Generate a fresh session token (never stored with the exchange)
  const rawToken = randomBytes(32).toString("hex");
  const rotated = await store.rotateSessionToken({
    sessionId: exchange.sessionId,
    proxyHostId: audience.proxyHostId,
    audienceOrigin: audience.origin,
    tokenHash: hashToken(rawToken),
  });
  if (!rotated) return null;

  return {
    sessionId: exchange.sessionId,
    redirectUri: exchange.redirectUri,
    rawSessionToken: rawToken
  };
}

// ── Host Access Control ──────────────────────────────────────────────

export type ForwardAuthAccessEntry = {
  id: number;
  proxyHostId: number;
  userId: number | null;
  groupId: number | null;
  createdAt: string;
};

/**
 * A forward-auth user as the access checks read it: one query, with the
 * state of their organisation (ee/multi-tenancy).
 */
export type ForwardAuthUser = {
  id: number;
  email: string;
  username: string | null;
  status: string;
  /** The user's organisation, or null for the provider level. */
  organizationId: number | null;
  /** False when the user's organisation is disabled or gone; true at the provider level. */
  organizationEnabled: boolean;
};

async function readForwardAuthUser(userId: number): Promise<ForwardAuthUser | null> {
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  const row = await first(appDb
    .select({
      id: users.id,
      email: users.email,
      username: users.username,
      status: users.status,
      organizationId: users.organizationId,
      organizationEnabled: organizations.enabled,
    })
    .from(users)
    .leftJoin(organizations, eq(organizations.id, users.organizationId))
    .where(eq(users.id, userId))
    .limit(1));
  if (!row) return null;
  const organizationId = row.organizationId ?? null;
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    status: row.status,
    organizationId,
    organizationEnabled: organizationId === null || row.organizationEnabled === true,
  };
}

/**
 * The groups `user` is a member of that belong to their own organisation (the
 * provider level's for a provider-level user), in membership order: the
 * groups that count for access and that the groups header names.
 */
async function sameTenantGroupsOf(user: ForwardAuthUser): Promise<{ id: number; name: string }[]> {
  return await appDb
    .select({ id: groups.id, name: groups.name })
    .from(groupMembers)
    .innerJoin(groups, eq(groupMembers.groupId, groups.id))
    .where(and(eq(groupMembers.userId, user.id), organizationCondition(groups.organizationId, user.organizationId)))
    .orderBy(asc(groupMembers.id));
}

/**
 * Whether a grant on host `proxyHostId` names `user` or one of `groupIds`,
 * the host belonging to the user's organisation (or both being
 * provider-level). One query: a missing host or one of another organisation
 * matches no row.
 */
async function hasHostGrant(user: ForwardAuthUser, proxyHostId: number, groupIds: readonly number[]): Promise<boolean> {
  if (!user.organizationEnabled || !Number.isSafeInteger(proxyHostId) || proxyHostId <= 0) return false;
  const grantee = groupIds.length > 0
    ? or(eq(forwardAuthAccess.userId, user.id), inArray(forwardAuthAccess.groupId, [...groupIds]))
    : eq(forwardAuthAccess.userId, user.id);
  const grant = await first(appDb
    .select({ id: forwardAuthAccess.id })
    .from(forwardAuthAccess)
    .innerJoin(proxyHosts, eq(proxyHosts.id, forwardAuthAccess.proxyHostId))
    .where(and(
      eq(forwardAuthAccess.proxyHostId, proxyHostId),
      organizationCondition(proxyHosts.organizationId, user.organizationId),
      grantee
    ))
    .limit(1));
  return !!grant;
}

/**
 * Whether user `userId` may pass forward auth on proxy host `proxyHostId`:
 * granted directly or through a group. With multi-tenancy (ee), a user only
 * ever passes hosts of their own organisation (provider-level users only
 * provider-level hosts), and nobody of a disabled organisation passes,
 * whatever the grants say: a portal sign-in never reaches another tenant's
 * host. Only groups of the user's own organisation count.
 */
export async function checkHostAccess(
  userId: number,
  proxyHostId: number
): Promise<boolean> {
  const user = await readForwardAuthUser(userId);
  if (!user || !user.organizationEnabled) return false;
  const userGroups = await sameTenantGroupsOf(user);
  return hasHostGrant(user, proxyHostId, userGroups.map((group) => group.id));
}

/**
 * The verify endpoint's decision for a valid session of user `userId` on host
 * `proxyHostId`: 401 when the user is gone or not active, 403 when
 * checkHostAccess refuses, otherwise the user and the groups the identity
 * headers name. Three reads at most, the user read once.
 */
export async function authorizeForwardAuthRequest(
  userId: number,
  proxyHostId: number
): Promise<
  | { status: 401 | 403 }
  | { status: 200; user: ForwardAuthUser; groups: { id: number; name: string }[] }
> {
  const user = await readForwardAuthUser(userId);
  if (!user || user.status !== "active") return { status: 401 };
  if (!user.organizationEnabled) return { status: 403 };
  const userGroups = await sameTenantGroupsOf(user);
  if (!(await hasHostGrant(user, proxyHostId, userGroups.map((group) => group.id)))) return { status: 403 };
  return { status: 200, user, groups: userGroups };
}

export async function getForwardAuthAccessForHost(
  proxyHostId: number
): Promise<ForwardAuthAccessEntry[]> {
  const rows = await appDb
    .select()
    .from(forwardAuthAccess)
    .where(eq(forwardAuthAccess.proxyHostId, proxyHostId))
    .orderBy(asc(forwardAuthAccess.id));

  return rows.map((r) => ({
    id: r.id,
    proxyHostId: r.proxyHostId,
    userId: r.userId,
    groupId: r.groupId,
    createdAt: toIso(r.createdAt)!
  }));
}

/**
 * The ids of a grant list: whole numbers (or their digits as text, which
 * SQLite used to accept the same way), without duplicates. Anything else is
 * refused (400) before the host's grants are touched.
 */
function grantIds(value: unknown, field: "userIds" | "groupIds"): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ApiValidationError(`${field} must be a list of ids`);
  const ids = value.map((id: unknown) => (typeof id === "string" && /^\d{1,15}$/.test(id) ? Number(id) : id));
  if (ids.some((id) => typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)) {
    throw new ApiValidationError(`${field} must be a list of ids`);
  }
  return [...new Set(ids as number[])];
}

/**
 * Replaces the forward-auth grants of host `proxyHostId`, in one
 * transaction. Users and groups that do not exist are left out (foreign keys
 * are not enforced, so a grant for an id nobody has yet would go to whoever
 * gets it); an organisation user naming one gets 404 (assertGrantsInTenant).
 */
export async function setForwardAuthAccess(
  proxyHostId: number,
  access: { userIds?: number[]; groupIds?: number[] },
  actorUserId: number
): Promise<ForwardAuthAccessEntry[]> {
  const requested = { userIds: grantIds(access.userIds, "userIds"), groupIds: grantIds(access.groupIds, "groupIds") };

  await appDb.transaction(async (tx) => {
    // Multi-tenancy (ee): only the actor's own organisation's hosts, and only
    // users and groups of the host's organisation.
    const host = await first(tx
      .select({ organizationId: proxyHosts.organizationId })
      .from(proxyHosts)
      .where(eq(proxyHosts.id, proxyHostId))
      .limit(1));
    if (!host) throw new Error("Proxy host not found");
    await assertActorReaches(actorUserId, host.organizationId, "Proxy host not found");
    await assertGrantsInTenant(tx, host.organizationId ?? null, requested, await actorOrganizationId(actorUserId));

    const userIds = requested.userIds.length === 0 ? [] : (await tx
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, requested.userIds)))
      .map((row) => row.id);
    const groupIds = requested.groupIds.length === 0 ? [] : (await tx
      .select({ id: groups.id })
      .from(groups)
      .where(inArray(groups.id, requested.groupIds)))
      .map((row) => row.id);

    await tx
      .delete(forwardAuthAccess)
      .where(eq(forwardAuthAccess.proxyHostId, proxyHostId));

    const now = nowIso();
    const values: Array<{
      proxyHostId: number;
      userId: number | null;
      groupId: number | null;
      createdAt: string;
    }> = [];
    // In the order asked for.
    const existingUsers = new Set(userIds);
    const existingGroups = new Set(groupIds);
    for (const uid of requested.userIds.filter((id) => existingUsers.has(id))) {
      values.push({ proxyHostId, userId: uid, groupId: null, createdAt: now });
    }
    for (const gid of requested.groupIds.filter((id) => existingGroups.has(id))) {
      values.push({ proxyHostId, userId: null, groupId: gid, createdAt: now });
    }
    if (values.length > 0) {
      await tx.insert(forwardAuthAccess).values(values);
    }
  });
  // Grants taken away end the sessions they allowed on every node (shared state).
  await revokeForwardAuthSessionsWithoutAccess({ proxyHostIds: [proxyHostId] });

  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "forward_auth_access",
    entityId: proxyHostId,
    summary: `Updated forward auth access for proxy host ${proxyHostId}`
  });

  return getForwardAuthAccessForHost(proxyHostId);
}

// ── Domain Validation ────────────────────────────────────────────────

function hasForwardAuthEnabled(ph: { meta: string | null }): boolean {
  let parsedMeta: unknown;
  try {
    parsedMeta = ph.meta ? JSON.parse(ph.meta) : {};
  } catch {
    return false;
  }
  if (typeof parsedMeta !== "object" || parsedMeta === null) return false;
  const fa = (parsedMeta as Record<string, unknown>).cpm_forward_auth as Record<string, unknown> | undefined;
  return !!fa?.enabled;
}

/** A host name as hostMatchesPattern compares it: trimmed, lowercase, without a trailing dot. */
function normalizeHostName(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * The enabled proxy hosts that can match host name `host`, in id order, with
 * only the columns the match needs: those whose domains contain the name
 * itself or the wildcard pattern one label up ("*.example.com" for
 * "app.example.com"), ignoring the case of ASCII letters. Every domain that
 * findForwardAuthProxyHost matches contains one of the two (a domain only
 * matches when it is the name, or the wildcard one label up, give or take
 * case, surrounding spaces and a trailing dot), so the rows left out could
 * not have matched; the request no longer reads every host and its
 * settings.
 */
async function forwardAuthHostCandidates(host: string): Promise<{ id: number; domains: string; meta: string | null }[]> {
  const name = normalizeHostName(host);
  if (!name) return [];
  const containing = [containsText(proxyHosts.domains, name)];
  const dot = name.indexOf(".");
  if (dot > 0 && dot < name.length - 1) containing.push(containsText(proxyHosts.domains, `*.${name.slice(dot + 1)}`));
  return await appDb
    .select({ id: proxyHosts.id, domains: proxyHosts.domains, meta: proxyHosts.meta })
    .from(proxyHosts)
    .where(and(eq(proxyHosts.enabled, true), or(...containing)))
    .orderBy(asc(proxyHosts.id));
}

async function findForwardAuthProxyHost(host: string) {
  const candidates = await forwardAuthHostCandidates(host);

  // Exact-match hosts take precedence over wildcard-covered ones: if an
  // explicit host exists for this domain, its own forward-auth setting
  // decides the outcome and the wildcard host is never consulted — this
  // mirrors the routing precedence Caddy itself applies. Among several, the
  // lowest id wins.
  let exactMatchFound = false;
  let wildcardMatch: (typeof candidates)[number] | null = null;

  for (const ph of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(ph.domains);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const domains = parsed.filter((d): d is string => typeof d === "string");
    if (domains.some((d) => d.toLowerCase() === host.toLowerCase())) {
      exactMatchFound = true;
      if (hasForwardAuthEnabled(ph)) return ph;
      continue;
    }
    if (!wildcardMatch && domains.some((d) => hostMatchesPattern(host, d))) {
      wildcardMatch = ph;
    }
  }

  if (!exactMatchFound && wildcardMatch) {
    return hasForwardAuthEnabled(wildcardMatch) ? wildcardMatch : null;
  }

  return null;
}

/**
 * Resolve a URL to one exact forward-auth audience.  Wildcard proxy hosts are
 * supported, but the resulting audience always contains the concrete origin
 * visited by the browser, never the wildcard pattern itself.
 */
export async function resolveForwardAuthAudience(
  targetUrl: string,
): Promise<ForwardAuthAudience | null> {
  const parsed = parseForwardAuthUrlAnyPort(targetUrl);
  if (!parsed) return null;

  const proxyHost = await findForwardAuthProxyHost(parsed.hostname);
  if (!proxyHost) return null;

  if (!isForwardAuthPortAllowed(parsed)) {
    reportDisallowedPort(parsed.hostname, parsed.port);
    return null;
  }

  return {
    origin: parsed.origin,
    hostname: parsed.hostname.toLowerCase(),
    proxyHostId: proxyHost.id,
  };
}

export async function isForwardAuthDomain(host: string): Promise<boolean> {
  return !!(await findForwardAuthProxyHost(host));
}

/**
 * The explicit port of `targetUrl` when that URL names a forward-auth host and
 * the port is not listed in FORWARD_AUTH_ALLOWED_PORTS, otherwise null.  Such
 * a URL can never be signed in to; the portal uses this to say why.
 */
export async function getDisallowedForwardAuthPort(targetUrl: string): Promise<string | null> {
  const parsed = parseForwardAuthUrlAnyPort(targetUrl);
  if (!parsed || isForwardAuthPortAllowed(parsed)) return null;
  if (!(await findForwardAuthProxyHost(parsed.hostname))) return null;
  reportDisallowedPort(parsed.hostname, parsed.port);
  return parsed.port;
}

// ── Cleanup ──────────────────────────────────────────────────────────

export async function cleanupExpiredSessions(): Promise<number> {
  return (await forwardAuthStateStore()).cleanupExpired();
}
