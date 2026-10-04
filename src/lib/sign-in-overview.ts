/**
 * The Sign-in and directories page as data (GET /api/v1/sign-in/overview):
 * enforced SSO with its break-glass accounts and the correct passwords it
 * refused, what the login page offers now, and one entry per place people
 * sign in from (OpenID Connect and OAuth providers, SAML providers, LDAP
 * directories with their health, SCIM provisioning), each with the accounts
 * that come from it, its group-to-role mappings and its last activity.
 *
 * Reads stored state only: it never connects to a directory or provider and
 * never checks the license. LDAP directories need ldap:read and SCIM
 * scim:read; without them those parts are null. No client secret, bind
 * password, key or token value is read into the result.
 */
import { and, count, eq, gte, inArray, isNull } from "drizzle-orm";
import { appDb } from "./db";
import { accounts, auditEvents, oauthProviders, scimUsers, users } from "./db/schema";
import { can, type Access } from "./permissions";
import { config } from "./config";
import { anyPasskeyExists } from "./passkeys";
import { listMfaAccountSummaries } from "./mfa";
import { getSsoEnforcementView } from "@/ee/sso/enforcement";
import { listProviders as listSamlProviders } from "@/ee/saml/providers";
import { listDirectories } from "@/ee/ldap/directories";
import { isDirectoryOpen } from "@/ee/ldap/sso";
import { ldapProviderId } from "@/ee/ldap/constants";
import { samlProviderId } from "@/ee/saml/constants";
import { signInSourceActivity } from "./sign-in-activity";
import type { DirectoryHealth } from "@/ee/ldap/health";
import { getScimSettingsView, listRoleMappings } from "@/ee/scim/service";
import { listScimTokens } from "@/ee/scim/tokens";
import { desc, first } from "@/src/lib/db/ops";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The window of the refused-password count. */
export const REFUSED_WINDOW_DAYS = 7;
/** How many account names an entry lists. */
const NAMES_SHOWN = 3;

/** The accounts that come from one source. */
export type SourceUsers = {
  total: number;
  /** Of them, active accounts that never signed in. */
  invited: number;
  /** The first few, by name or e-mail. */
  names: string[];
};

/** The newest dashboard sign-in through a source, and by whom. */
export type SourceSignIn = { at: string; user: string } | null;

export type BreakGlassView = {
  id: number;
  username: string | null;
  name: string | null;
  email: string;
  role: string;
  status: string;
  passwordSignIn: boolean;
  validAdmin: boolean;
  authenticatorApp: boolean;
  passkeys: number;
  lastSignInAt: string | null;
  lastSignInMethod: string | null;
};

/** One way in that the login page offers, as it stands now. */
export type LoginOption = {
  kind: "oidc" | "saml" | "ldap" | "password" | "passkey";
  label: string;
  /** offered; unavailable: shown but failing; break_glass: only break-glass accounts may use it. */
  state: "offered" | "unavailable" | "break_glass";
};

export type OidcSourceView = {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  issuer: string | null;
  /** Where the browser is sent: the issuer's or authorization URL's host. */
  host: string | null;
  scopes: string;
  autoLink: boolean;
  users: SourceUsers;
  lastSignIn: SourceSignIn;
};

export type SamlSourceView = {
  id: number;
  name: string;
  enabled: boolean;
  idpEntityId: string;
  users: SourceUsers;
  lastSignIn: SourceSignIn;
  mappings: { group: string; role: string }[];
  defaultRole: string;
  requiredGroup: string | null;
  provisionUsers: boolean;
  linkExistingAccounts: boolean;
  /** The attribute accounts are linked by; null: the NameID. */
  subjectAttribute: string | null;
  /** The IdP signing certificate that expires first. */
  certificate: { notAfter: string; expired: boolean; count: number } | null;
  signsRequests: boolean;
  warnings: string[];
};

export type LdapSourceView = {
  id: number;
  name: string;
  enabled: boolean;
  url: string;
  transport: "tls" | "starttls" | "unencrypted";
  /** A CA certificate of its own is configured (otherwise the system trust store). */
  ownCaCertificate: boolean;
  users: SourceUsers;
  lastSignIn: SourceSignIn;
  mappings: { group: string; role: string }[];
  defaultRole: string;
  groupMode: string;
  nestedGroups: boolean;
  requiredGroup: string | null;
  provisionUsers: boolean;
  allowWhenSsoEnforced: boolean;
  /** The directory takes sign-ins now (enabled, and open under enforced SSO). */
  open: boolean;
  /** The periodic connection check; null until an enabled directory was first checked. */
  health: DirectoryHealth | null;
  warnings: string[];
};

export type ScimSourceView = {
  enabled: boolean;
  configurable: boolean;
  endpointUrl: string;
  /** The OAuth/OIDC or SAML provider SCIM users sign in with. */
  signInProvider: string | null;
  deleteMode: "disable" | "delete";
  manageRoles: boolean;
  defaultRole: string;
  users: SourceUsers;
  groups: number;
  mappings: { group: string; role: string; priority: number }[];
  tokens: { count: number; latest: { name: string; prefix: string; lastUsedAt: string | null } | null };
  /** The newest change a SCIM request made, from the audit log. */
  lastChange: { at: string; summary: string } | null;
};

export type SignInOverview = {
  generatedAt: string;
  enforcement: {
    enabled: boolean;
    configurable: boolean;
    warnings: string[];
    /** The last change of the setting, from the audit log. */
    changedAt: string | null;
    changedBy: string | null;
    breakGlass: BreakGlassView[];
    /** Correct passwords refused because SSO is enforced, in the last REFUSED_WINDOW_DAYS days. */
    refusedLastWeek: number;
  };
  loginPage: LoginOption[];
  /** Accounts may be created at a first OAuth sign-in (AUTH_ALLOW_OAUTH_REGISTRATION). */
  oauthRegistration: boolean;
  /** A new OAuth account may take its role from the provider's claims (AUTH_ALLOW_OAUTH_ROLE_FROM_CLAIMS). */
  oauthRoleFromClaims: boolean;
  oidc: OidcSourceView[];
  saml: SamlSourceView[];
  /** Null without ldap:read. */
  ldap: LdapSourceView[] | null;
  /** Null without scim:read. */
  scim: ScimSourceView | null;
};

type UserRow = {
  id: number;
  name: string | null;
  email: string;
  status: string;
  lastSignInAt: string | null;
  lastSignInMethod: string | null;
};

function clean(text: string | null | undefined, maxLength = 300): string {
  return (text ?? "").replace(/\p{Cc}+/gu, " ").slice(0, maxLength);
}

function iso(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function displayName(user: Pick<UserRow, "name" | "email">): string {
  return clean(user.name || user.email, 100);
}

function summarizeUsers(rows: readonly UserRow[]): SourceUsers {
  const sorted = [...rows].sort((a, b) => displayName(a).localeCompare(displayName(b)));
  return {
    total: rows.length,
    invited: rows.filter((row) => row.status === "active" && !row.lastSignInAt).length,
    names: sorted.slice(0, NAMES_SHOWN).map(displayName),
  };
}

/**
 * The newest dashboard sign-in through each identity provider, as
 * sign_in_sources records it when a sign-in completes, with the name of who
 * made it ("Deleted account" when that account is gone).
 */
async function providerSignIns(): Promise<(providerId: string) => SourceSignIn> {
  const activity = await signInSourceActivity();
  const ids = [...new Set([...activity.values()].map((entry) => entry.userId).filter((id): id is number => id !== null))];
  const names = new Map(
    ids.length === 0
      ? []
      : (await appDb.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ids))).map((row) => [row.id, displayName(row)])
  );
  return (providerId) => {
    const entry = activity.get(providerId);
    const at = iso(entry?.at);
    if (!entry || !at) return null;
    return { at, user: (entry.userId === null ? undefined : names.get(entry.userId)) ?? "Deleted account" };
  };
}

/** Accounts by sign-in provider id (accounts.providerId). */
async function linkedUsers(): Promise<Map<string, UserRow[]>> {
  const rows = await appDb
    .select({
      providerId: accounts.providerId,
      id: users.id,
      name: users.name,
      email: users.email,
      status: users.status,
      lastSignInAt: users.lastSignInAt,
      lastSignInMethod: users.lastSignInMethod,
    })
    .from(accounts)
    .innerJoin(users, eq(users.id, accounts.userId));
  const byProvider = new Map<string, UserRow[]>();
  for (const row of rows) {
    if (row.providerId === "credential") continue;
    const { providerId, ...user } = row;
    const list = byProvider.get(providerId) ?? [];
    if (!list.some((item) => item.id === user.id)) list.push(user);
    byProvider.set(providerId, list);
  }
  return byProvider;
}

async function enforcementChange(): Promise<{ at: string | null; by: string | null }> {
  const row = await first(appDb
    .select({ at: auditEvents.createdAt, userId: auditEvents.userId })
    .from(auditEvents)
    .where(eq(auditEvents.action, "sso_enforcement_updated"))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(1));
  if (!row) return { at: null, by: null };
  const actor = row.userId === null
    ? undefined
    : await first(appDb.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, row.userId)).limit(1));
  return { at: iso(row.at), by: actor ? displayName(actor) : null };
}

async function refusedSince(since: Date): Promise<number> {
  return (await first(appDb
    .select({ value: count() })
    .from(auditEvents)
    .where(and(eq(auditEvents.action, "sso_enforced_sign_in_refused"), gte(auditEvents.createdAt, since.toISOString())))
    .limit(1)))?.value ?? 0;
}

async function lastScimChange(): Promise<ScimSourceView["lastChange"]> {
  // SCIM requests are recorded without a user, their summary naming the token (ee/scim/audit.ts).
  const rows = await appDb
    .select({ at: auditEvents.createdAt, summary: auditEvents.summary, userId: auditEvents.userId })
    .from(auditEvents)
    .where(isNull(auditEvents.userId))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(200);
  const row = rows.find((entry) => entry.summary?.startsWith('SCIM token "'));
  return row ? { at: iso(row.at)!, summary: clean(row.summary) } : null;
}

function roleLabel(role: string, customRoleName?: string | null): string {
  if (customRoleName) return customRoleName;
  return role === "admin" ? "Admin" : role === "user" ? "User" : role === "viewer" ? "Viewer" : role;
}

/** Everything the Sign-in and directories page shows, for `access`. */
export async function getSignInOverview(access: Access, now: Date = new Date()): Promise<SignInOverview> {
  const view = await getSsoEnforcementView();
  const change = await enforcementChange();
  const mfa = new Map((await listMfaAccountSummaries(now)).map((account) => [account.id, account]));
  const breakGlassIds = view.breakGlassAccounts.map((account) => account.id);
  const signIns = new Map(
    (breakGlassIds.length === 0
      ? []
      : await appDb.select({ id: users.id, at: users.lastSignInAt, method: users.lastSignInMethod }).from(users).where(inArray(users.id, breakGlassIds))
    ).map((row) => [row.id, row])
  );
  const breakGlass: BreakGlassView[] = view.breakGlassAccounts.map((account) => ({
    id: account.id,
    username: account.username,
    name: account.name,
    email: account.email,
    role: account.role,
    status: account.status,
    passwordSignIn: account.passwordSignIn,
    validAdmin: account.validAdmin,
    authenticatorApp: mfa.get(account.id)?.authenticatorApp ?? false,
    passkeys: mfa.get(account.id)?.passkeys ?? 0,
    lastSignInAt: iso(signIns.get(account.id)?.at),
    lastSignInMethod: signIns.get(account.id)?.method ?? null,
  }));

  const byProvider = await linkedUsers();
  const lastSignInThrough = await providerSignIns();

  const oidc: OidcSourceView[] = (await appDb
    .select({
      id: oauthProviders.id,
      name: oauthProviders.name,
      type: oauthProviders.type,
      enabled: oauthProviders.enabled,
      issuer: oauthProviders.issuer,
      authorizationUrl: oauthProviders.authorizationUrl,
      scopes: oauthProviders.scopes,
      autoLink: oauthProviders.autoLink,
    })
    .from(oauthProviders))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((row) => {
      const linked = byProvider.get(row.id) ?? [];
      return {
        id: row.id,
        name: row.name,
        type: row.type,
        enabled: row.enabled,
        issuer: row.issuer,
        host: hostOf(row.issuer) ?? hostOf(row.authorizationUrl),
        scopes: row.scopes,
        autoLink: row.autoLink,
        users: summarizeUsers(linked),
        lastSignIn: lastSignInThrough(row.id),
      };
    });

  const saml: SamlSourceView[] = (await listSamlProviders()).map((provider) => {
    const linked = byProvider.get(samlProviderId(provider.id)) ?? [];
    const certificates = [...provider.certificates].sort((a, b) => a.notAfter.localeCompare(b.notAfter));
    return {
      id: provider.id,
      name: provider.name,
      enabled: provider.enabled,
      idpEntityId: provider.idpEntityId,
      users: summarizeUsers(linked),
      lastSignIn: lastSignInThrough(samlProviderId(provider.id)),
      mappings: provider.groupRoleMappings.map((mapping) => ({ group: mapping.group, role: roleLabel(mapping.role) })),
      defaultRole: roleLabel(provider.defaultRole),
      requiredGroup: provider.requiredGroup,
      provisionUsers: provider.provisionUsers,
      linkExistingAccounts: provider.linkExistingAccounts,
      subjectAttribute: provider.subjectAttribute,
      certificate: certificates[0]
        ? { notAfter: certificates[0].notAfter, expired: certificates[0].expired, count: certificates.length }
        : null,
      signsRequests: provider.signsRequests,
      warnings: provider.warnings,
    };
  });

  const ldap: LdapSourceView[] | null = can(access, "ldap:read")
    ? (await listDirectories()).map((directory) => {
        const linked = byProvider.get(ldapProviderId(directory.id)) ?? [];
        return {
          id: directory.id,
          name: directory.name,
          enabled: directory.enabled,
          url: directory.url,
          transport: directory.url.toLowerCase().startsWith("ldaps:") ? "tls" : directory.startTls ? "starttls" : "unencrypted",
          ownCaCertificate: Boolean(directory.caCertificate),
          users: summarizeUsers(linked),
          lastSignIn: lastSignInThrough(ldapProviderId(directory.id)),
          mappings: directory.groupRoleMappings.map((mapping) => ({ group: mapping.group, role: roleLabel(mapping.role) })),
          defaultRole: roleLabel(directory.defaultRole),
          groupMode: directory.groupMode,
          nestedGroups: directory.nestedGroups,
          requiredGroup: directory.requiredGroup,
          provisionUsers: directory.provisionUsers,
          allowWhenSsoEnforced: directory.allowWhenSsoEnforced,
          open: isDirectoryOpen(directory, view.enabled),
          health: directory.health,
          warnings: directory.warnings,
        };
      })
    : null;

  let scim: ScimSourceView | null = null;
  if (can(access, "scim:read")) {
    const settings = await getScimSettingsView();
    const tokens = await listScimTokens();
    const latestToken = [...tokens]
      .filter((token) => token.lastUsedAt)
      .sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""))[0] ?? tokens[0];
    const scimRows = await appDb
      .select({ id: users.id, name: users.name, email: users.email, status: users.status, lastSignInAt: users.lastSignInAt, lastSignInMethod: users.lastSignInMethod })
      .from(scimUsers)
      .innerJoin(users, eq(users.id, scimUsers.userId))
      .where(isNull(scimUsers.deletedAt));
    scim = {
      enabled: settings.enabled,
      configurable: settings.configurable,
      endpointUrl: settings.endpointUrl,
      signInProvider: settings.providers.find((provider) => provider.id === settings.providerId)?.name ?? null,
      deleteMode: settings.deleteMode,
      manageRoles: settings.manageRoles,
      defaultRole: roleLabel(settings.defaultRole),
      users: summarizeUsers(scimRows),
      groups: settings.counts.groups,
      mappings: (await listRoleMappings()).map((mapping) => ({
        group: mapping.groupName,
        role: roleLabel(mapping.role, mapping.customRoleName),
        priority: mapping.priority,
      })),
      tokens: {
        count: tokens.length,
        latest: latestToken ? { name: latestToken.name, prefix: latestToken.prefix, lastUsedAt: latestToken.lastUsedAt } : null,
      },
      lastChange: await lastScimChange(),
    };
  }

  const loginPage: LoginOption[] = [];
  for (const provider of oidc) if (provider.enabled) loginPage.push({ kind: "oidc", label: `Continue with ${provider.name}`, state: "offered" });
  for (const provider of saml) if (provider.enabled) loginPage.push({ kind: "saml", label: `Continue with ${provider.name}`, state: "offered" });
  // Directories are listed for everyone the page is shown to: the login page offers them to anyone.
  const directories = ldap ?? await listDirectories();
  for (const directory of directories) {
    if (!isDirectoryOpen(directory, view.enabled)) continue;
    loginPage.push({
      kind: "ldap",
      label: `Sign in with ${directory.name}`,
      state: directory.health?.status === "failing" ? "unavailable" : "offered",
    });
  }
  const ssoProviders = view.ssoProviders.length > 0;
  loginPage.push({
    kind: "password",
    label: view.enabled && ssoProviders ? "Break-glass sign-in" : "Username and password",
    state: view.enabled ? "break_glass" : "offered",
  });
  let passkeys: boolean;
  try {
    passkeys = await anyPasskeyExists();
  } catch {
    passkeys = false;
  }
  if (passkeys) loginPage.push({ kind: "passkey", label: "Sign in with a passkey", state: view.enabled ? "break_glass" : "offered" });

  return {
    generatedAt: now.toISOString(),
    enforcement: {
      enabled: view.enabled,
      configurable: view.configurable,
      warnings: view.warnings,
      changedAt: change.at,
      changedBy: change.by,
      breakGlass,
      refusedLastWeek: await refusedSince(new Date(now.getTime() - REFUSED_WINDOW_DAYS * DAY_MS)),
    },
    loginPage,
    oauthRegistration: config.auth.allowOauthRegistration,
    oauthRoleFromClaims: config.auth.allowOauthRoleFromClaims,
    oidc,
    saml,
    ldap,
    scim,
  };
}
