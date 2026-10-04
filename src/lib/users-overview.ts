/**
 * The Users and groups page as data (GET /api/v1/users/overview and
 * GET /api/v1/groups/overview): every account with where it comes from, its
 * second factor, who decides its role and its last use; every forward-auth
 * group with its members, whether SCIM manages it, the role SCIM mappings
 * give its members and the hosts it lets them reach.
 *
 * Reads only. Callers pass the Access of the signed-in user and the
 * organisation filter (ee/multi-tenancy) the page or request uses; what the
 * caller may not read is left out (null), never filled with someone else's
 * data. No secret, password hash or token value is read into the result.
 */
import { and, eq, inArray, isNotNull, isNull, max } from "drizzle-orm";
import { appDb } from "./db";
import {
  accounts,
  apiTokens,
  customRoles,
  forwardAuthAccess,
  ldapDirectories,
  oauthProviders,
  proxyHosts,
  samlGroupRoles,
  samlProviders,
  scimGroups,
  scimRoleMappings,
  scimUsers,
} from "./db/schema";
import { listUsers, type User } from "./models/user";
import { listGroups } from "./models/groups";
import { canSignInWithPassword, getMfaPolicyView, listMfaAccountSummaries, type MfaGate, type MfaPolicyScope } from "./mfa";
import { can, scopeTagsFor, tagsInScope, type Access } from "./permissions";
import { parseStoredTags } from "./host-tags";
import { readSsoEnforcement } from "@/ee/sso/enforcement-store";
import { parseLdapProviderId } from "@/ee/ldap/constants";
import { PRIMARY_ADMIN_USER_ID, readScimSettings } from "@/ee/scim/store";
import { listCustomRoleViews } from "@/ee/custom-roles/store";
import { organizationCondition, type OrganizationFilter } from "@/ee/multi-tenancy/scope";
import { asc, first } from "@/src/lib/db/ops";

export type AccountSourceKind = "local" | "oidc" | "saml" | "ldap" | "scim";

/** One way an account comes to the dashboard: its password, a linked identity provider or directory, or SCIM. */
export type AccountSource = { kind: AccountSourceKind; label: string };

/**
 * What protects the account's sign-in beyond the first step:
 *  - authenticator_app / passkey: a second factor set up here;
 *  - identity_provider: the account signs in only through an identity
 *    provider, which asks for its own second factor;
 *  - none: the account can sign in with a password and has no second factor;
 *  - not_needed: the account cannot sign in to the dashboard at all (API tokens only).
 */
export type SecondFactorState = "authenticator_app" | "passkey" | "identity_provider" | "none" | "not_needed";

export type UserSecondFactor = {
  state: SecondFactorState;
  authenticatorApp: boolean;
  passkeys: number;
  /** The MFA policy requires a second factor of this account. */
  required: boolean;
  /** none: nothing asked; prompt: set it up before `deadline`; required: overdue. */
  gate: MfaGate;
  deadline: string | null;
};

export type UserOverviewEntry = {
  id: number;
  email: string;
  name: string | null;
  username: string | null;
  role: User["role"];
  customRoleId: number | null;
  organizationId: number | null;
  status: string;
  lastSignInAt: string | null;
  lastSignInMethod: string | null;
  /** When the account was disabled; null while it is not, or when unknown (disabled before drizzle/0047). */
  disabledAt: string | null;
  invited: boolean;
  createdAt: string;
  sources: AccountSource[];
  /** The account can sign in on the login page with a password (its own or a directory's). */
  passwordSignIn: boolean;
  secondFactor: UserSecondFactor;
  /** A directory, SAML provider or SCIM sets the role at each sign-in or change; a change made here does not last. */
  roleManagedBy: string | null;
  /** Holds administrator-level access: the admin role, an organisation administrator or an administrator-level custom role. */
  administrator: boolean;
  /** One of the break-glass accounts of enforced SSO (ee/sso). */
  breakGlass: boolean;
  /** The account ADMIN_USERNAME and ADMIN_PASSWORD manage. */
  primaryAdmin: boolean;
  /** The last time one of the account's API tokens was used. */
  apiTokenLastUsedAt: string | null;
};

export type UsersOverview = {
  generatedAt: string;
  users: UserOverviewEntry[];
  /** The MFA policy; null without mfa_policy:read. */
  mfaPolicy: {
    scope: MfaPolicyScope;
    graceDays: number;
    deadline: string | null;
    required: number;
    enrolled: number;
  } | null;
};

function clean(text: string | null | undefined, maxLength = 100): string {
  return (text ?? "").replace(/\p{Cc}+/gu, " ").slice(0, maxLength);
}

function parseMappingCount(raw: string | null | undefined): number {
  try {
    const parsed = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

type SourceIndex = {
  sources: Map<number, AccountSource[]>;
  roleManagers: Map<number, string>;
};

/** Sources and role managers of `userIds`, from their sign-in accounts and SCIM. */
async function indexSources(userIds: readonly number[], protectedIds: ReadonlySet<number>): Promise<SourceIndex> {
  const sources = new Map<number, AccountSource[]>();
  const roleManagers = new Map<number, string>();
  if (userIds.length === 0) return { sources, roleManagers };
  const ids = [...userIds];
  const oauthNames = new Map((await appDb.select({ id: oauthProviders.id, name: oauthProviders.name }).from(oauthProviders)).map((row) => [row.id, row.name]));
  const directories = new Map(
    (await appDb.select({ id: ldapDirectories.id, name: ldapDirectories.name, mappings: ldapDirectories.groupRoleMappings })
      .from(ldapDirectories))
      .map((row) => [row.id, { name: row.name, mapped: parseMappingCount(row.mappings) > 0 }])
  );
  const samlNames = new Map((await appDb.select({ id: samlProviders.id, name: samlProviders.name }).from(samlProviders)).map((row) => [row.id, row.name]));
  const mappedSaml = new Set((await appDb.select({ providerId: samlGroupRoles.providerId }).from(samlGroupRoles)).map((row) => row.providerId));

  const add = (userId: number, source: AccountSource) => {
    const list = sources.get(userId) ?? [];
    if (!list.some((item) => item.kind === source.kind && item.label === source.label)) list.push(source);
    sources.set(userId, list);
  };

  const rows = await appDb
    .select({ userId: accounts.userId, providerId: accounts.providerId, password: accounts.password })
    .from(accounts)
    .where(inArray(accounts.userId, ids))
    .orderBy(asc(accounts.id));
  for (const row of rows) {
    if (row.providerId === "credential") {
      if (row.password) add(row.userId, { kind: "local", label: "Password" });
      continue;
    }
    const directoryId = parseLdapProviderId(row.providerId);
    if (directoryId !== null) {
      const directory = directories.get(directoryId);
      const label = clean(directory?.name ?? `Directory #${directoryId}`);
      add(row.userId, { kind: "ldap", label });
      if (directory?.mapped && !protectedIds.has(row.userId)) roleManagers.set(row.userId, `${label} sets the role at each sign-in`);
      continue;
    }
    if (row.providerId.startsWith("saml:")) {
      const providerId = Number(row.providerId.slice(5));
      const label = clean(samlNames.get(providerId) ?? "SAML provider");
      add(row.userId, { kind: "saml", label });
      if (mappedSaml.has(providerId) && !roleManagers.has(row.userId) && !protectedIds.has(row.userId)) {
        roleManagers.set(row.userId, `${label} sets the role at each sign-in`);
      }
      continue;
    }
    add(row.userId, { kind: "oidc", label: clean(oauthNames.get(row.providerId) ?? row.providerId) });
  }

  const scim = await readScimSettings(appDb);
  const scimMapped = scim.manageRoles && await first(appDb.select({ id: scimRoleMappings.id }).from(scimRoleMappings).limit(1)) !== undefined;
  for (const row of await appDb.select({ userId: scimUsers.userId }).from(scimUsers).where(and(inArray(scimUsers.userId, ids), isNull(scimUsers.deletedAt)))) {
    add(row.userId, { kind: "scim", label: "SCIM provisioning" });
    if (scimMapped && !roleManagers.has(row.userId) && !protectedIds.has(row.userId)) {
      roleManagers.set(row.userId, "SCIM group mappings set the role");
    }
  }
  return { sources, roleManagers };
}

function secondFactorOf(
  summary: { authenticatorApp: boolean; passkeys: number; required: boolean; gate: MfaGate } | undefined,
  passwordSignIn: boolean,
  sources: readonly AccountSource[],
  deadline: string | null
): UserSecondFactor {
  const authenticatorApp = summary?.authenticatorApp ?? false;
  const passkeys = summary?.passkeys ?? 0;
  const base = {
    authenticatorApp,
    passkeys,
    required: summary?.required ?? false,
    gate: summary?.gate ?? "none",
    deadline: summary && summary.gate !== "none" ? deadline : null,
  };
  if (authenticatorApp) return { state: "authenticator_app", ...base };
  if (passkeys > 0) return { state: "passkey", ...base };
  if (passwordSignIn) return { state: "none", ...base };
  if (sources.some((source) => source.kind === "oidc" || source.kind === "saml")) return { state: "identity_provider", ...base };
  return { state: "not_needed", ...base };
}

/** Every account `access` may list in `organizationId`, as the Users page shows it. */
export async function getUsersOverview(access: Access, organizationId: OrganizationFilter, now: Date = new Date()): Promise<UsersOverview> {
  const list = await listUsers(organizationId);
  const ids = list.map((user) => user.id);
  const listed = new Set(ids);
  const breakGlass = new Set((await readSsoEnforcement(appDb)).breakGlassUserIds.filter((id) => listed.has(id)));
  const protectedIds = new Set([PRIMARY_ADMIN_USER_ID, ...breakGlass]);
  const { sources, roleManagers } = await indexSources(ids, protectedIds);
  const mfa = new Map((await listMfaAccountSummaries(now)).filter((account) => listed.has(account.id)).map((account) => [account.id, account]));
  const policy = await getMfaPolicyView(now);
  const adminLevelRoles = new Set((await listCustomRoleViews(appDb)).filter((role) => role.adminLevel).map((role) => role.id));
  const tokenUse = new Map(
    (ids.length === 0
      ? []
      : await appDb.select({ userId: apiTokens.createdBy, at: max(apiTokens.lastUsedAt) })
        .from(apiTokens)
        .where(and(inArray(apiTokens.createdBy, ids), isNotNull(apiTokens.lastUsedAt)))
        .groupBy(apiTokens.createdBy)
    ).map((row) => [row.userId, row.at ? new Date(row.at).toISOString() : null])
  );

  const passwordSignIns = new Map<number, boolean>();
  for (const user of list) passwordSignIns.set(user.id, await canSignInWithPassword(appDb, user.id));

  const users: UserOverviewEntry[] = list.map((user) => {
    const userSources = sources.get(user.id) ?? [];
    const passwordSignIn = passwordSignIns.get(user.id) === true;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      username: user.username,
      role: user.role,
      customRoleId: user.customRoleId,
      organizationId: user.organizationId,
      status: user.status,
      lastSignInAt: user.lastSignInAt,
      lastSignInMethod: user.lastSignInMethod,
      disabledAt: user.disabledAt,
      invited: user.invited,
      createdAt: user.createdAt,
      sources: userSources,
      passwordSignIn,
      secondFactor: secondFactorOf(mfa.get(user.id), passwordSignIn, userSources, policy.deadline),
      roleManagedBy: roleManagers.get(user.id) ?? null,
      administrator:
        (user.customRoleId === null && (user.role === "admin" || user.role === "org_admin")) ||
        (user.customRoleId !== null && adminLevelRoles.has(user.customRoleId)),
      breakGlass: breakGlass.has(user.id),
      primaryAdmin: user.id === PRIMARY_ADMIN_USER_ID,
      apiTokenLastUsedAt: tokenUse.get(user.id) ?? null,
    };
  });

  return {
    generatedAt: now.toISOString(),
    users,
    mfaPolicy: can(access, "mfa_policy:read")
      ? {
          scope: policy.scope,
          graceDays: policy.graceDays,
          deadline: policy.deadline,
          required: policy.accounts.required,
          enrolled: policy.accounts.enrolled,
        }
      : null,
  };
}

// ── Groups ───────────────────────────────────────────────────────────────

export type GroupRoleMappingSummary = {
  role: "admin" | "user" | "viewer";
  customRoleId: number | null;
  customRoleName: string | null;
  priority: number;
};

export type GroupOverviewEntry = {
  id: number;
  name: string;
  description: string | null;
  organizationId: number | null;
  createdAt: string;
  updatedAt: string;
  members: { userId: number; email: string; name: string | null }[];
  /** SCIM manages the group (ee/scim): the identity provider changes its members. Null: managed here. */
  scim: { origin: "scim" | "adopted"; updatedAt: string } | null;
  /** The SCIM group-to-role mappings of the group; null without scim:read. */
  roleMappings: GroupRoleMappingSummary[] | null;
  /** The proxy hosts whose forward auth lets the group in; null without proxy_hosts:read. */
  hosts: { id: number; name: string; domain: string }[] | null;
};

export type GroupsOverview = { generatedAt: string; groups: GroupOverviewEntry[] };

function firstDomain(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && typeof parsed[0] === "string") return parsed[0];
  } catch {
    // fall through
  }
  return "";
}

/** Every forward-auth group `access` may list in `organizationId`, as the Groups tab shows it. */
export async function getGroupsOverview(access: Access, organizationId: OrganizationFilter, now: Date = new Date()): Promise<GroupsOverview> {
  const list = await listGroups(organizationId);
  const ids = list.map((group) => group.id);
  const managed = new Map(
    (ids.length === 0 ? [] : await appDb.select().from(scimGroups).where(inArray(scimGroups.groupId, ids)))
      .map((row) => [row.groupId, { origin: (row.origin === "adopted" ? "adopted" : "scim") as "scim" | "adopted", updatedAt: new Date(row.updatedAt).toISOString() }])
  );

  let mappings: Map<number, GroupRoleMappingSummary[]> | null = null;
  if (can(access, "scim:read")) {
    mappings = new Map();
    const rows = ids.length === 0
      ? []
      : await appDb.select({ mapping: scimRoleMappings, customRoleName: customRoles.name })
        .from(scimRoleMappings)
        .leftJoin(customRoles, eq(customRoles.id, scimRoleMappings.customRoleId))
        .where(inArray(scimRoleMappings.groupId, ids))
        .orderBy(asc(scimRoleMappings.priority), asc(scimRoleMappings.id));
    for (const { mapping, customRoleName } of rows) {
      const entry: GroupRoleMappingSummary = {
        role: mapping.role === "admin" || mapping.role === "user" ? mapping.role : "viewer",
        customRoleId: mapping.customRoleId ?? null,
        customRoleName: customRoleName ?? null,
        priority: mapping.priority,
      };
      mappings.set(mapping.groupId, [...(mappings.get(mapping.groupId) ?? []), entry]);
    }
  }

  let hosts: Map<number, { id: number; name: string; domain: string }[]> | null = null;
  if (can(access, "proxy_hosts:read")) {
    hosts = new Map();
    const grants = ids.length === 0
      ? []
      : await appDb.select({ groupId: forwardAuthAccess.groupId, proxyHostId: forwardAuthAccess.proxyHostId })
        .from(forwardAuthAccess)
        .where(and(isNotNull(forwardAuthAccess.groupId), inArray(forwardAuthAccess.groupId, ids)));
    const hostIds = [...new Set(grants.map((grant) => grant.proxyHostId))];
    const scope = scopeTagsFor(access, "proxy_hosts");
    const visible = new Map(
      (hostIds.length === 0
        ? []
        : await appDb.select({ id: proxyHosts.id, name: proxyHosts.name, domains: proxyHosts.domains, tags: proxyHosts.tags })
          .from(proxyHosts)
          .where(and(inArray(proxyHosts.id, hostIds), organizationCondition(proxyHosts.organizationId, organizationId)))
      )
        // A role limited to tags sees only the hosts it reaches.
        .filter((row) => tagsInScope(parseStoredTags(row.tags), scope))
        .map((row) => [row.id, { id: row.id, name: row.name, domain: firstDomain(row.domains) || row.name }])
    );
    for (const grant of grants) {
      const host = visible.get(grant.proxyHostId);
      if (!host || grant.groupId === null) continue;
      const bucket = hosts.get(grant.groupId) ?? [];
      if (!bucket.some((item) => item.id === host.id)) bucket.push(host);
      hosts.set(grant.groupId, bucket);
    }
    for (const bucket of hosts.values()) bucket.sort((a, b) => a.domain.localeCompare(b.domain));
  }

  return {
    generatedAt: now.toISOString(),
    groups: list.map((group) => ({
      id: group.id,
      name: group.name,
      description: group.description,
      organizationId: group.organizationId,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      members: group.members.map((member) => ({ userId: member.userId, email: member.email, name: member.name })),
      scim: managed.get(group.id) ?? null,
      roleMappings: mappings ? mappings.get(group.id) ?? [] : null,
      hosts: hosts ? hosts.get(group.id) ?? [] : null,
    })),
  };
}
