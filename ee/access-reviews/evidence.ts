// SPDX-License-Identifier: Elastic-2.0
/**
 * Evidence for access review items, so a reviewer decides from facts rather
 * than memory: for each person, how their account signs in (its sources),
 * their last sign-in and how many in the last 30 days, the last change they
 * made (from the audit log), whether a directory sets their role at sign-in;
 * and for each item when that access was last used.
 *
 * Sources: the audit log (sign-ins, changes, forward-auth sign-ins), the
 * sign-in accounts, sessions and forward-auth sessions, API tokens'
 * lastUsedAt. Read when asked, never stored with the campaign; nothing here
 * changes anything.
 */
import { and, eq, gte, inArray, isNotNull, max, notInArray } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import {
  accessReviewCampaigns,
  accessReviewItems,
  accounts,
  apiTokens,
  auditEvents,
  forwardAuthAccess,
  forwardAuthSessions,
  ldapDirectories,
  oauthProviders,
  passkeys,
  proxyHosts,
  samlGroupRoles,
  samlProviders,
  scimRoleMappings,
  scimUsers,
  sessions,
  users,
} from "@/src/lib/db/schema";
import { ApiClientError } from "@/src/lib/api-errors";
import { parseLdapProviderId } from "@/ee/ldap/constants";
import { NON_CHANGE_AUDIT_ACTIONS } from "@/ee/ai/digest-data";
import type { ItemKind } from "./types";
import { desc, first } from "@/src/lib/db/ops";

const DAY_MS = 24 * 60 * 60 * 1000;
export const SIGN_IN_WINDOW_DAYS = 30;
export const QUIET_CHANGE_DAYS = 90;
const FORWARD_AUTH_LOGINS_READ = 200;

export type AccountSource = { kind: "local" | "oidc" | "ldap" | "saml" | "scim"; label: string };

export type SubjectEvidence = {
  userId: number;
  /** The account still exists. */
  exists: boolean;
  status: string | null;
  sources: AccountSource[];
  /** A second factor is set up: an authenticator app or a passkey. */
  mfa: boolean;
  lastSignIn: { at: string; summary: string | null } | null;
  signInsLast30Days: number;
  lastChange: { at: string; action: string; entityType: string; summary: string | null } | null;
  /** A directory or identity provider decides the role at each sign-in, so revoking a role here may not last. */
  roleManagedBy: string | null;
};

export type ItemEvidence = {
  itemId: number;
  kind: ItemKind;
  /** When this access was last used, and how. */
  lastUsed: { at: string; detail: string } | null;
  /** A remark for the reviewer, e.g. "No change in the last 90 days". */
  note: string | null;
};

export type CampaignEvidence = { campaignId: number; generatedAt: string; subjects: SubjectEvidence[]; items: ItemEvidence[] };

function iso(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function clean(text: string | null | undefined, max = 200): string | null {
  if (!text) return null;
  return text.replace(/\p{Cc}+/gu, " ").slice(0, max);
}

/** How each user signs in: password, OAuth/OIDC providers, LDAP directories, SAML providers, SCIM. */
async function sourcesOf(userIds: number[]): Promise<Map<number, AccountSource[]>> {
  const result = new Map<number, AccountSource[]>();
  if (userIds.length === 0) return result;
  const oauthNames = new Map((await appDb.select({ id: oauthProviders.id, name: oauthProviders.name }).from(oauthProviders)).map((row) => [row.id, row.name]));
  const ldapNames = new Map((await appDb.select({ id: ldapDirectories.id, name: ldapDirectories.name }).from(ldapDirectories)).map((row) => [row.id, row.name]));
  const samlNames = new Map((await appDb.select({ id: samlProviders.id, name: samlProviders.name }).from(samlProviders)).map((row) => [row.id, row.name]));
  const add = (userId: number, source: AccountSource) => {
    const list = result.get(userId) ?? [];
    if (!list.some((item) => item.kind === source.kind && item.label === source.label)) list.push(source);
    result.set(userId, list);
  };
  const rows = await appDb
    .select({ userId: accounts.userId, providerId: accounts.providerId, password: accounts.password })
    .from(accounts)
    .where(inArray(accounts.userId, userIds));
  for (const row of rows) {
    if (row.providerId === "credential") {
      if (row.password) add(row.userId, { kind: "local", label: "Password" });
      continue;
    }
    const directoryId = parseLdapProviderId(row.providerId);
    if (directoryId !== null) {
      add(row.userId, { kind: "ldap", label: clean(ldapNames.get(directoryId) ?? `Directory #${directoryId}`, 100)! });
      continue;
    }
    if (row.providerId.startsWith("saml:")) {
      const id = Number(row.providerId.slice(5));
      add(row.userId, { kind: "saml", label: clean(samlNames.get(id) ?? "SAML provider", 100)! });
      continue;
    }
    add(row.userId, { kind: "oidc", label: clean(oauthNames.get(row.providerId) ?? row.providerId, 100)! });
  }
  for (const row of await appDb.select({ userId: scimUsers.userId }).from(scimUsers).where(inArray(scimUsers.userId, userIds))) {
    add(row.userId, { kind: "scim", label: "SCIM provisioning" });
  }
  return result;
}

/** Who decides the role at sign-in: a directory or provider with a group-to-role mapping the account signs in through. */
async function roleManagersOf(userIds: number[], sources: Map<number, AccountSource[]>): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (userIds.length === 0) return result;
  const mappedDirectories = new Set(
    (await appDb
      .select({ id: ldapDirectories.id, mappings: ldapDirectories.groupRoleMappings })
      .from(ldapDirectories))
      .filter((row) => {
        try {
          const parsed = JSON.parse(row.mappings);
          return Array.isArray(parsed) && parsed.length > 0;
        } catch {
          return false;
        }
      })
      .map((row) => row.id)
  );
  const mappedSaml = new Set((await appDb.select({ providerId: samlGroupRoles.providerId }).from(samlGroupRoles)).map((row) => row.providerId));
  const scimMapped = await first(appDb.select({ id: scimRoleMappings.id }).from(scimRoleMappings).limit(1)) !== undefined;
  for (const row of await appDb.select({ userId: accounts.userId, providerId: accounts.providerId }).from(accounts).where(inArray(accounts.userId, userIds))) {
    const directoryId = parseLdapProviderId(row.providerId);
    if (directoryId !== null && mappedDirectories.has(directoryId)) {
      const label = sources.get(row.userId)?.find((source) => source.kind === "ldap")?.label ?? "the directory";
      result.set(row.userId, `${label} sets the role at each sign-in`);
    } else if (row.providerId.startsWith("saml:") && mappedSaml.has(Number(row.providerId.slice(5)))) {
      const label = sources.get(row.userId)?.find((source) => source.kind === "saml")?.label ?? "the SAML provider";
      result.set(row.userId, `${label} sets the role at each sign-in`);
    }
  }
  if (scimMapped) {
    for (const userId of userIds) {
      if (!result.has(userId) && sources.get(userId)?.some((source) => source.kind === "scim")) {
        result.set(userId, "SCIM group mappings set the role");
      }
    }
  }
  return result;
}

async function lastSignIns(userIds: number[]): Promise<Map<number, { at: string; summary: string | null }>> {
  const result = new Map<number, { at: string; summary: string | null }>();
  for (const userId of userIds) {
    const event = await first(appDb
      .select({ at: auditEvents.createdAt, summary: auditEvents.summary })
      .from(auditEvents)
      .where(and(eq(auditEvents.userId, userId), eq(auditEvents.action, "login_success")))
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(1));
    const session = await first(appDb.select({ at: max(sessions.createdAt) }).from(sessions).where(eq(sessions.userId, userId)).limit(1));
    const eventAt = iso(event?.at);
    const sessionAt = iso(session?.at ?? null);
    if (eventAt && (!sessionAt || eventAt >= sessionAt)) result.set(userId, { at: eventAt, summary: clean(event?.summary ?? null) });
    else if (sessionAt) result.set(userId, { at: sessionAt, summary: null });
  }
  return result;
}

async function signInCounts(userIds: number[], since: Date): Promise<Map<number, number>> {
  if (userIds.length === 0) return new Map();
  const rows = await appDb
    .select({ userId: auditEvents.userId, at: auditEvents.createdAt })
    .from(auditEvents)
    .where(and(inArray(auditEvents.userId, userIds), eq(auditEvents.action, "login_success"), gte(auditEvents.createdAt, since.toISOString())));
  const counts = new Map<number, number>();
  for (const row of rows) if (row.userId !== null) counts.set(row.userId, (counts.get(row.userId) ?? 0) + 1);
  return counts;
}

async function lastChanges(userIds: number[]): Promise<Map<number, SubjectEvidence["lastChange"]>> {
  const result = new Map<number, SubjectEvidence["lastChange"]>();
  for (const userId of userIds) {
    const row = await first(appDb
      .select({ at: auditEvents.createdAt, action: auditEvents.action, entityType: auditEvents.entityType, summary: auditEvents.summary })
      .from(auditEvents)
      .where(and(eq(auditEvents.userId, userId), notInArray(auditEvents.action, NON_CHANGE_AUDIT_ACTIONS as unknown as string[])))
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(1));
    if (row) result.set(userId, { at: iso(row.at)!, action: row.action, entityType: row.entityType, summary: clean(row.summary, 300) });
  }
  return result;
}

/** The most recent forward-auth sign-in of `userId` to one of `hostIds`. */
async function lastForwardAuthUse(userId: number, hostIds: number[], hostDomains: Map<number, string[]>): Promise<{ at: string; detail: string } | null> {
  if (hostIds.length === 0) return null;
  const domainToHost = new Map<string, number>();
  for (const id of hostIds) for (const domain of hostDomains.get(id) ?? []) domainToHost.set(domain, id);
  let best: { at: string; detail: string } | null = null;
  const session = await first(appDb
    .select({ at: forwardAuthSessions.createdAt, proxyHostId: forwardAuthSessions.proxyHostId })
    .from(forwardAuthSessions)
    .where(and(eq(forwardAuthSessions.userId, userId), inArray(forwardAuthSessions.proxyHostId, hostIds)))
    .orderBy(desc(forwardAuthSessions.createdAt), desc(forwardAuthSessions.id))
    .limit(1));
  if (session) {
    const domain = hostDomains.get(session.proxyHostId)?.[0] ?? `host #${session.proxyHostId}`;
    best = { at: iso(session.at)!, detail: `Forward-auth sign-in to ${domain}` };
  }
  const logins = await appDb
    .select({ at: auditEvents.createdAt, summary: auditEvents.summary })
    .from(auditEvents)
    .where(and(eq(auditEvents.userId, userId), eq(auditEvents.action, "forward_auth_login")))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(FORWARD_AUTH_LOGINS_READ);
  for (const login of logins) {
    const host = login.summary?.match(/ to ([a-z0-9.-]+)$/i)?.[1]?.toLowerCase();
    if (!host || !domainToHost.has(host)) continue;
    const at = iso(login.at)!;
    if (!best || at > best.at) best = { at, detail: `Forward-auth sign-in to ${host}` };
    break;
  }
  return best;
}

function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase()) : [];
  } catch {
    return [];
  }
}

/** Evidence for every item of campaign `campaignId`. */
export async function getCampaignEvidence(campaignId: number, now: Date = new Date()): Promise<CampaignEvidence> {
  // Every fact from one read-only snapshot of the database.
  return await appDb.transaction(async () => await readCampaignEvidence(campaignId, now), { readOnly: true });
}

async function readCampaignEvidence(campaignId: number, now: Date): Promise<CampaignEvidence> {
  const campaign = await first(appDb.select({ id: accessReviewCampaigns.id }).from(accessReviewCampaigns).where(eq(accessReviewCampaigns.id, campaignId)).limit(1));
  if (!campaign) throw new ApiClientError("Access review not found", 404);
  const items = await appDb.select().from(accessReviewItems).where(eq(accessReviewItems.campaignId, campaignId)).orderBy(accessReviewItems.id);
  const userIds = [...new Set(items.map((item) => item.subjectUserId))];
  const userRows = userIds.length === 0 ? [] : await appDb.select({ id: users.id, status: users.status, twoFactorEnabled: users.twoFactorEnabled }).from(users).where(inArray(users.id, userIds));
  const userById = new Map(userRows.map((row) => [row.id, row]));
  const withPasskeys = new Set(
    (userIds.length === 0 ? [] : await appDb.selectDistinct({ userId: passkeys.userId }).from(passkeys).where(inArray(passkeys.userId, userIds)))
      .map((row) => row.userId)
  );
  const sources = await sourcesOf(userIds);
  const managers = await roleManagersOf(userIds, sources);
  const signIns = await lastSignIns(userIds);
  const counts = await signInCounts(userIds, new Date(now.getTime() - SIGN_IN_WINDOW_DAYS * DAY_MS));
  const changes = await lastChanges(userIds);

  const subjects: SubjectEvidence[] = userIds.map((userId) => {
    const user = userById.get(userId);
    return {
      userId,
      exists: user !== undefined,
      status: user?.status ?? null,
      sources: sources.get(userId) ?? [],
      mfa: user?.twoFactorEnabled === true || withPasskeys.has(userId),
      lastSignIn: signIns.get(userId) ?? null,
      signInsLast30Days: counts.get(userId) ?? 0,
      lastChange: changes.get(userId) ?? null,
      roleManagedBy: managers.get(userId) ?? null,
    };
  });

  const tokenIds = items.filter((item) => item.kind === "api_token" && item.targetId !== null).map((item) => item.targetId!);
  const tokens = new Map(
    (tokenIds.length === 0 ? [] : await appDb.select({ id: apiTokens.id, lastUsedAt: apiTokens.lastUsedAt }).from(apiTokens).where(inArray(apiTokens.id, tokenIds))).map((row) => [row.id, row.lastUsedAt])
  );
  const groupIds = items.filter((item) => item.kind === "group" && item.targetId !== null).map((item) => item.targetId!);
  const grants = groupIds.length === 0
    ? []
    : await appDb.select({ groupId: forwardAuthAccess.groupId, proxyHostId: forwardAuthAccess.proxyHostId }).from(forwardAuthAccess).where(and(isNotNull(forwardAuthAccess.groupId), inArray(forwardAuthAccess.groupId, groupIds)));
  const hostIds = [...new Set(grants.map((grant) => grant.proxyHostId))];
  const hostDomains = new Map(
    (hostIds.length === 0 ? [] : await appDb.select({ id: proxyHosts.id, domains: proxyHosts.domains }).from(proxyHosts).where(inArray(proxyHosts.id, hostIds))).map((row) => [row.id, parseList(row.domains)])
  );
  const quietSince = now.getTime() - QUIET_CHANGE_DAYS * DAY_MS;

  const itemEvidence: ItemEvidence[] = await Promise.all(items.map(async (item): Promise<ItemEvidence> => {
    const subject = subjects.find((entry) => entry.userId === item.subjectUserId)!;
    const kind = item.kind as ItemKind;
    switch (kind) {
      case "account": {
        const signIn = subject.lastSignIn;
        return {
          itemId: item.id,
          kind,
          lastUsed: signIn ? { at: signIn.at, detail: `${subject.signInsLast30Days} sign-in${subject.signInsLast30Days === 1 ? "" : "s"} in ${SIGN_IN_WINDOW_DAYS} days` } : null,
          note: signIn ? null : "No recorded sign-in",
        };
      }
      case "role": {
        const change = subject.lastChange;
        return {
          itemId: item.id,
          kind,
          lastUsed: change ? { at: change.at, detail: change.summary ?? change.action } : null,
          note: subject.roleManagedBy ?? (!change || Date.parse(change.at) < quietSince ? `No change in the last ${QUIET_CHANGE_DAYS} days` : null),
        };
      }
      case "group": {
        const hosts = grants.filter((grant) => grant.groupId === item.targetId).map((grant) => grant.proxyHostId);
        const use = await lastForwardAuthUse(item.subjectUserId, hosts, hostDomains);
        return { itemId: item.id, kind, lastUsed: use, note: hosts.length === 0 ? "The group grants no host" : use ? null : "No recorded sign-in to its hosts" };
      }
      case "api_token": {
        const exists = item.targetId !== null && tokens.has(item.targetId);
        const lastUsedAt = item.targetId !== null ? iso(tokens.get(item.targetId) ?? null) : null;
        return {
          itemId: item.id,
          kind,
          lastUsed: lastUsedAt ? { at: lastUsedAt, detail: "API request" } : null,
          note: !exists ? "The token no longer exists" : lastUsedAt ? null : "Never used",
        };
      }
      default:
        return { itemId: item.id, kind, lastUsed: null, note: null };
    }
  }));
  return { campaignId, generatedAt: now.toISOString(), subjects, items: itemEvidence };
}
