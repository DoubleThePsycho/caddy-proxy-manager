// SPDX-License-Identifier: Elastic-2.0
/**
 * LDAP / Active Directory directories: validation, storage and the
 * administrator actions on them.
 *
 * Directories are per dashboard, like the users and accounts they sign in:
 * they are not synced to slaves.
 */
import { X509Certificate } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { accounts, ldapDirectories } from "@/src/lib/db/schema";
import { encryptSecret } from "@/src/lib/secret";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiClientError, ApiConflictError, ApiValidationError } from "@/src/lib/api-errors";
import {
  GROUP_MODES,
  LDAP_DEFAULT_ROLES,
  LDAP_ROLES,
  LIMITS,
  ldapProviderId,
  type GroupMode,
  type LdapRole,
} from "./constants";
import { dnProblem, filterTemplateProblem, isAttributeName, normalizeDn } from "./filter";
import { getDirectoryRow, rowSettings, type DirectorySettings, type LdapDirectoryRow } from "./store";
import { clearDirectoryHealth, readAllDirectoryHealth, readDirectoryHealth, type DirectoryHealth } from "./health";
import type { DirectoryConfig, GroupRoleMapping, LdapDirectoryView } from "./types";
import { asc, first } from "@/src/lib/db/ops";

export type { LdapDirectoryRow } from "./store";

export const DIRECTORY_NOT_FOUND = "Directory not found";

const DEFAULTS = {
  connectTimeoutMs: 5000,
  operationTimeoutMs: 10_000,
  usernameAttribute: "uid",
  emailAttribute: "mail",
  displayNameAttribute: "cn",
  uniqueIdAttribute: "entryUUID",
  groupMembershipAttribute: "memberOf",
  defaultRole: "user" as const,
};

const FIELDS = [
  "name",
  "enabled",
  "url",
  "startTls",
  "allowUnencrypted",
  "caCertificate",
  "connectTimeoutMs",
  "operationTimeoutMs",
  "bindDn",
  "bindPassword",
  "userSearchBase",
  "userSearchFilter",
  "usernameAttribute",
  "emailAttribute",
  "displayNameAttribute",
  "uniqueIdAttribute",
  "groupMode",
  "groupMembershipAttribute",
  "groupSearchBase",
  "groupSearchFilter",
  "nestedGroups",
  "groupRoleMappings",
  "defaultRole",
  "requiredGroup",
  "provisionUsers",
  "linkExistingAccounts",
  "allowWhenSsoEnforced",
] as const;

// ── Validation ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (!(FIELDS as readonly string[]).includes(key)) throw new ApiValidationError(`Unknown field "${key}"`);
  }
}

function parseName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiValidationError("name is required");
  const name = value.trim();
  if (name.length > LIMITS.name) throw new ApiValidationError(`name must be at most ${LIMITS.name} characters`);
  if (/\p{Cc}/u.test(name)) throw new ApiValidationError("name must not contain control characters");
  return name;
}

function parseBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ApiValidationError(`${field} must be true or false`);
  return value;
}

/** ldaps:// or ldap://, a host and an optional port; nothing else. Messages never echo the URL. */
export function parseDirectoryUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiValidationError("url is required");
  const text = value.trim();
  if (text.length > LIMITS.url) throw new ApiValidationError("url is too long");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ApiValidationError("url must be a URL such as ldaps://ldap.example.com:636");
  }
  if (url.protocol !== "ldaps:" && url.protocol !== "ldap:") throw new ApiValidationError("url must start with ldaps:// or ldap://");
  if (!url.hostname) throw new ApiValidationError("url must include a host");
  if (url.username || url.password) throw new ApiValidationError("url must not contain credentials");
  if ((url.pathname && url.pathname !== "/") || url.search || text.includes("#")) {
    throw new ApiValidationError("url must not have a path, query or fragment; put the search base in its own field");
  }
  return `${url.protocol}//${url.host}`;
}

function parseCaCertificate(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ApiValidationError("caCertificate must be a PEM string");
  const pem = value.trim();
  if (!pem) return null;
  if (pem.length > LIMITS.caCertificate) throw new ApiValidationError("caCertificate is too large");
  if (/PRIVATE KEY/.test(pem)) throw new ApiValidationError("caCertificate must hold certificates only, never a private key");
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length === 0) throw new ApiValidationError("caCertificate must be one or more PEM certificates");
  for (const block of blocks) {
    try {
      new X509Certificate(block);
    } catch {
      throw new ApiValidationError("caCertificate holds a certificate that cannot be read");
    }
  }
  return blocks.join("\n");
}

function parseTimeout(value: unknown, field: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ApiValidationError(`${field} must be a whole number of milliseconds from ${min} to ${max}`);
  }
  return value;
}

function parseDn(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ApiValidationError(`${field} is required`);
  const problem = dnProblem(value);
  if (problem) throw new ApiValidationError(`${field} ${problem}`);
  return value.trim();
}

function parseOptionalDn(value: unknown, field: string): string | null {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return null;
  return parseDn(value, field);
}

/** undefined (or "") keeps the stored value. Kept exactly as typed: it is a password. */
function parseBindPassword(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new ApiValidationError("bindPassword must be a string");
  if (!value.trim()) throw new ApiValidationError("bindPassword must not be blank");
  if (value.length > LIMITS.bindPassword || value.includes("\0")) {
    throw new ApiValidationError(`bindPassword must be at most ${LIMITS.bindPassword} characters without NUL`);
  }
  return value;
}

function parseAttribute(value: unknown, field: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !isAttributeName(value.trim())) {
    throw new ApiValidationError(`${field} must be an attribute name such as ${fallback}`);
  }
  return value.trim();
}

function parseFilter(value: unknown, field: string, allowed: Array<"username" | "dn">, required: Array<"username" | "dn">): string {
  if (typeof value !== "string") throw new ApiValidationError(`${field} is required`);
  const problem = filterTemplateProblem(value, allowed, required);
  if (problem) throw new ApiValidationError(`${field} ${problem}`);
  return value.trim();
}

function parseGroupMode(value: unknown, fallback: GroupMode): GroupMode {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !(GROUP_MODES as readonly string[]).includes(value)) {
    throw new ApiValidationError(`groupMode must be one of ${GROUP_MODES.join(", ")}`);
  }
  return value as GroupMode;
}

function parseMappings(value: unknown, fallback: GroupRoleMapping[]): GroupRoleMapping[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) throw new ApiValidationError("groupRoleMappings must be an array of {group, role}");
  if (value.length > LIMITS.mappings) throw new ApiValidationError(`groupRoleMappings takes at most ${LIMITS.mappings} entries`);
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)) throw new ApiValidationError(`groupRoleMappings[${index}] must be an object with group and role`);
    for (const key of Object.keys(item)) {
      if (key !== "group" && key !== "role") throw new ApiValidationError(`groupRoleMappings[${index}] has an unknown field "${key}"`);
    }
    const group = parseDn(item.group, `groupRoleMappings[${index}].group`);
    if (typeof item.role !== "string" || !(LDAP_ROLES as readonly string[]).includes(item.role)) {
      throw new ApiValidationError(`groupRoleMappings[${index}].role must be one of ${LDAP_ROLES.join(", ")}`);
    }
    const key = normalizeDn(group);
    if (seen.has(key)) throw new ApiValidationError(`groupRoleMappings lists the group ${group} twice`);
    seen.add(key);
    return { group, role: item.role as LdapRole };
  });
}

function parseDefaultRole(value: unknown, fallback: "user" | "viewer"): "user" | "viewer" {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !(LDAP_DEFAULT_ROLES as readonly string[]).includes(value)) {
    throw new ApiValidationError(`defaultRole must be one of ${LDAP_DEFAULT_ROLES.join(", ")}; administrators come from a group mapping only`);
  }
  return value as "user" | "viewer";
}

/** A directory as validated input; the service account password undefined keeps the stored one (updates only). */
export type ParsedDirectory = Omit<DirectoryConfig, "id" | "bindPassword"> & { bindPassword: string | undefined };

/**
 * Validates a create (existing null) or update body. Fields left out keep
 * their stored values (or get the defaults on create); the settings are then
 * checked together.
 */
function parseDirectory(body: unknown, existing: LdapDirectoryRow | null): ParsedDirectory {
  if (!isRecord(body)) throw new ApiValidationError("Request body must be a JSON object");
  rejectUnknownKeys(body);
  const stored = existing ? rowSettings(existing) : null;
  const pick = (key: (typeof FIELDS)[number]) => body[key];

  const url = pick("url") === undefined && stored ? stored.url : parseDirectoryUrl(pick("url"));
  const ldaps = url.startsWith("ldaps:");
  const startTls = parseBoolean(pick("startTls"), "startTls", stored && stored.url === url ? stored.startTls : !ldaps);
  const allowUnencrypted = parseBoolean(pick("allowUnencrypted"), "allowUnencrypted", ldaps ? false : stored?.allowUnencrypted ?? false);
  if (ldaps && startTls) throw new ApiValidationError("startTls is only used with ldap:// URLs; ldaps:// is TLS already");
  if (ldaps && allowUnencrypted) throw new ApiValidationError("allowUnencrypted is only used with ldap:// URLs");
  if (!ldaps && !startTls && !allowUnencrypted) {
    throw new ApiValidationError(
      "An ldap:// URL needs StartTLS. Use ldaps://, turn on startTls, or turn on allowUnencrypted to send passwords in clear text"
    );
  }

  const bindPassword = parseBindPassword(pick("bindPassword"));
  if (!existing && bindPassword === undefined) throw new ApiValidationError("bindPassword is required");
  if (existing && url !== existing.url && bindPassword === undefined) {
    // A stored password is never sent to a server it was not entered for.
    throw new ApiValidationError("Enter the service account password again when changing the URL");
  }

  const groupMode = parseGroupMode(pick("groupMode"), stored?.groupMode ?? "none");
  const nestedGroups = parseBoolean(pick("nestedGroups"), "nestedGroups", stored?.nestedGroups ?? false);
  const groupSearchBase = pick("groupSearchBase") === undefined ? stored?.groupSearchBase ?? null : parseOptionalDn(pick("groupSearchBase"), "groupSearchBase");
  let groupSearchFilter: string | null = stored?.groupSearchFilter ?? null;
  if (pick("groupSearchFilter") !== undefined) {
    const raw = pick("groupSearchFilter");
    groupSearchFilter = raw === null || (typeof raw === "string" && !raw.trim())
      ? null
      : parseFilter(raw, "groupSearchFilter", ["dn", "username"], ["dn", "username"]);
  }
  const groupRoleMappings = parseMappings(pick("groupRoleMappings"), stored?.groupRoleMappings ?? []);
  const requiredGroup = pick("requiredGroup") === undefined ? stored?.requiredGroup ?? null : parseOptionalDn(pick("requiredGroup"), "requiredGroup");

  if (groupMode === "none") {
    if (nestedGroups) throw new ApiValidationError("nestedGroups needs a group lookup (groupMode member_of)");
    if (groupRoleMappings.length > 0) throw new ApiValidationError("groupRoleMappings need a group lookup (groupMode member_of or search)");
    if (requiredGroup) throw new ApiValidationError("requiredGroup needs a group lookup (groupMode member_of or search)");
  }
  if (groupMode === "search") {
    if (!groupSearchBase) throw new ApiValidationError("groupSearchBase is required when groupMode is search");
    if (!groupSearchFilter) throw new ApiValidationError("groupSearchFilter is required when groupMode is search");
    if (nestedGroups) {
      throw new ApiValidationError(
        "nestedGroups is for groupMode member_of; with search, put the matching rule in the filter, for example (member:1.2.840.113556.1.4.1941:={dn})"
      );
    }
  }
  if (groupMode === "member_of" && nestedGroups && !groupSearchBase) {
    throw new ApiValidationError("nestedGroups needs groupSearchBase: nested groups are found with a search below it");
  }

  return {
    name: pick("name") === undefined && stored ? stored.name : parseName(pick("name")),
    enabled: parseBoolean(pick("enabled"), "enabled", stored?.enabled ?? true),
    url,
    startTls,
    allowUnencrypted,
    caCertificate: pick("caCertificate") === undefined ? stored?.caCertificate ?? null : parseCaCertificate(pick("caCertificate")),
    connectTimeoutMs: parseTimeout(
      pick("connectTimeoutMs"), "connectTimeoutMs", stored?.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs,
      LIMITS.minConnectTimeoutMs, LIMITS.maxConnectTimeoutMs
    ),
    operationTimeoutMs: parseTimeout(
      pick("operationTimeoutMs"), "operationTimeoutMs", stored?.operationTimeoutMs ?? DEFAULTS.operationTimeoutMs,
      LIMITS.minOperationTimeoutMs, LIMITS.maxOperationTimeoutMs
    ),
    bindDn: pick("bindDn") === undefined && stored ? stored.bindDn : parseDn(pick("bindDn"), "bindDn"),
    bindPassword,
    userSearchBase: pick("userSearchBase") === undefined && stored ? stored.userSearchBase : parseDn(pick("userSearchBase"), "userSearchBase"),
    userSearchFilter: pick("userSearchFilter") === undefined && stored
      ? stored.userSearchFilter
      : parseFilter(pick("userSearchFilter"), "userSearchFilter", ["username"], ["username"]),
    usernameAttribute: parseAttribute(pick("usernameAttribute"), "usernameAttribute", stored?.usernameAttribute ?? DEFAULTS.usernameAttribute),
    emailAttribute: parseAttribute(pick("emailAttribute"), "emailAttribute", stored?.emailAttribute ?? DEFAULTS.emailAttribute),
    displayNameAttribute: parseAttribute(
      pick("displayNameAttribute"), "displayNameAttribute", stored?.displayNameAttribute ?? DEFAULTS.displayNameAttribute
    ),
    uniqueIdAttribute: parseAttribute(pick("uniqueIdAttribute"), "uniqueIdAttribute", stored?.uniqueIdAttribute ?? DEFAULTS.uniqueIdAttribute),
    groupMode,
    groupMembershipAttribute: parseAttribute(
      pick("groupMembershipAttribute"), "groupMembershipAttribute", stored?.groupMembershipAttribute ?? DEFAULTS.groupMembershipAttribute
    ),
    groupSearchBase,
    groupSearchFilter,
    nestedGroups,
    groupRoleMappings,
    defaultRole: parseDefaultRole(pick("defaultRole"), stored?.defaultRole ?? DEFAULTS.defaultRole),
    requiredGroup,
    provisionUsers: parseBoolean(pick("provisionUsers"), "provisionUsers", stored?.provisionUsers ?? false),
    linkExistingAccounts: parseBoolean(pick("linkExistingAccounts"), "linkExistingAccounts", stored?.linkExistingAccounts ?? false),
    allowWhenSsoEnforced: parseBoolean(pick("allowWhenSsoEnforced"), "allowWhenSsoEnforced", stored?.allowWhenSsoEnforced ?? false),
  };
}

export function parseDirectoryCreate(body: unknown): ParsedDirectory & { bindPassword: string } {
  return parseDirectory(body, null) as ParsedDirectory & { bindPassword: string };
}

export function parseDirectoryUpdate(body: unknown, existing: LdapDirectoryRow): ParsedDirectory {
  return parseDirectory(body, existing);
}

/**
 * Whether an update only turns the directory off: `enabled: false`, with any
 * other field repeating its stored value and no new password. Nothing
 * stored is validated again, so a directory can always be turned off.
 */
export function isDisableOnlyUpdate(body: unknown, existing: LdapDirectoryRow): boolean {
  if (!isRecord(body) || body.enabled !== false) return false;
  const stored = rowSettings(existing) as unknown as Record<string, unknown>;
  return Object.entries(body).every(([key, value]) => {
    if (key === "enabled") return true;
    if (key === "bindPassword") return value === undefined || value === "";
    if (!(key in stored)) return false;
    const current = stored[key];
    if (typeof value === "string") return value.trim() === (current ?? "");
    if (value === null) return current === null;
    return JSON.stringify(value) === JSON.stringify(current);
  });
}

// ── Storage ──────────────────────────────────────────────────────────

/** Settings worth a second look; shown with the directory, never blocking. */
export function directoryWarnings(settings: DirectorySettings): string[] {
  const warnings: string[] = [];
  if (settings.url.startsWith("ldap:") && !settings.startTls && settings.allowUnencrypted) {
    warnings.push("Passwords are sent to this directory without encryption. Use ldaps:// or StartTLS.");
  }
  if (settings.provisionUsers && !settings.requiredGroup) {
    warnings.push("Every user the search finds gets an account at first sign-in. Consider a required group.");
  }
  if (settings.allowWhenSsoEnforced) {
    warnings.push("Directory sign-in stays open while enforced SSO is on.");
  }
  return warnings;
}

async function linkedAccountCounts(): Promise<Map<string, number>> {
  const rows = await appDb
    .select({ providerId: accounts.providerId, total: count() })
    .from(accounts)
    .groupBy(accounts.providerId);
  return new Map(rows.map((row) => [row.providerId, row.total]));
}

export async function toDirectoryView(row: LdapDirectoryRow, linked?: number, health?: DirectoryHealth | null): Promise<LdapDirectoryView> {
  const settings = rowSettings(row);
  return {
    id: row.id,
    ...settings,
    hasBindPassword: Boolean(row.bindPassword),
    linkedAccounts: linked ?? (await linkedAccountCounts()).get(ldapProviderId(row.id)) ?? 0,
    warnings: directoryWarnings(settings),
    // The periodic connection check (health.ts); null until the first check of an enabled directory.
    health: health !== undefined ? health : await readDirectoryHealth(row.id),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function requireDirectoryRow(id: number): Promise<LdapDirectoryRow> {
  const row = await getDirectoryRow(id);
  if (!row) throw new ApiClientError(DIRECTORY_NOT_FOUND, 404);
  return row;
}

export async function listDirectories(): Promise<LdapDirectoryView[]> {
  const counts = await linkedAccountCounts();
  const health = await readAllDirectoryHealth();
  const rows = await appDb
    .select()
    .from(ldapDirectories)
    .orderBy(asc(ldapDirectories.name), asc(ldapDirectories.id));
  return Promise.all(rows.map((row) => toDirectoryView(row, counts.get(ldapProviderId(row.id)) ?? 0, health.get(row.id) ?? null)));
}

export async function getDirectory(id: number): Promise<LdapDirectoryView> {
  return await toDirectoryView(await requireDirectoryRow(id));
}

async function assertNameAvailable(name: string, exceptId: number | null): Promise<void> {
  const clash = await first(appDb
    .select({ id: ldapDirectories.id })
    .from(ldapDirectories)
    .where(eq(ldapDirectories.name, name))
    .limit(1));
  if (clash && clash.id !== exceptId) throw new ApiConflictError(`A directory named "${name}" already exists`);
}

function auditData(input: DirectorySettings) {
  return {
    name: input.name,
    enabled: input.enabled,
    url: input.url,
    startTls: input.startTls,
    allowUnencrypted: input.allowUnencrypted,
    caCertificate: input.caCertificate !== null,
    bindDn: input.bindDn,
    userSearchBase: input.userSearchBase,
    userSearchFilter: input.userSearchFilter,
    groupMode: input.groupMode,
    nestedGroups: input.nestedGroups,
    groupRoleMappings: input.groupRoleMappings,
    defaultRole: input.defaultRole,
    requiredGroup: input.requiredGroup,
    provisionUsers: input.provisionUsers,
    linkExistingAccounts: input.linkExistingAccounts,
    allowWhenSsoEnforced: input.allowWhenSsoEnforced,
  };
}

function columns(input: ParsedDirectory) {
  return {
    name: input.name,
    enabled: input.enabled,
    url: input.url,
    startTls: input.startTls,
    allowUnencrypted: input.allowUnencrypted,
    caCertificate: input.caCertificate,
    connectTimeoutMs: input.connectTimeoutMs,
    operationTimeoutMs: input.operationTimeoutMs,
    bindDn: input.bindDn,
    ...(input.bindPassword !== undefined ? { bindPassword: encryptSecret(input.bindPassword) } : {}),
    userSearchBase: input.userSearchBase,
    userSearchFilter: input.userSearchFilter,
    usernameAttribute: input.usernameAttribute,
    emailAttribute: input.emailAttribute,
    displayNameAttribute: input.displayNameAttribute,
    uniqueIdAttribute: input.uniqueIdAttribute,
    groupMode: input.groupMode,
    groupMembershipAttribute: input.groupMembershipAttribute,
    groupSearchBase: input.groupSearchBase,
    groupSearchFilter: input.groupSearchFilter,
    nestedGroups: input.nestedGroups,
    groupRoleMappings: JSON.stringify(input.groupRoleMappings),
    defaultRole: input.defaultRole,
    requiredGroup: input.requiredGroup,
    provisionUsers: input.provisionUsers,
    linkExistingAccounts: input.linkExistingAccounts,
    allowWhenSsoEnforced: input.allowWhenSsoEnforced,
  };
}

// ── Administrator actions ────────────────────────────────────────────

export async function createDirectory(body: unknown, actorUserId: number): Promise<LdapDirectoryView> {
  const input = parseDirectoryCreate(body);
  const bindPassword = encryptSecret(input.bindPassword);
  const stamp = nowIso();
  // The name check and the insert in one transaction: two directories never share a name.
  const row = await appDb.transaction(async (tx) => {
    await assertNameAvailable(input.name, null);
    return (await first(tx
      .insert(ldapDirectories)
      .values({ ...columns(input), bindPassword, createdBy: actorUserId, createdAt: stamp, updatedAt: stamp })
      .returning()))!;
  });
  await logAuditEvent({
    userId: actorUserId,
    action: "ldap_directory_created",
    entityType: "ldap_directory",
    entityId: row.id,
    summary: `Created LDAP directory "${input.name}" (${input.url})`,
    data: auditData(input),
  });
  return await toDirectoryView(row, 0);
}

export async function updateDirectory(id: number, body: unknown, actorUserId: number): Promise<LdapDirectoryView> {
  const existing = await requireDirectoryRow(id);
  if (isDisableOnlyUpdate(body, existing)) {
    // Turning off: nothing stored is validated again.
    const row = (await first(appDb
      .update(ldapDirectories)
      .set({ enabled: false, updatedAt: nowIso() })
      .where(eq(ldapDirectories.id, id))
      .returning()))!;
    await logAuditEvent({
      userId: actorUserId,
      action: "ldap_directory_updated",
      entityType: "ldap_directory",
      entityId: id,
      summary: `Updated LDAP directory "${existing.name}": disabled`,
      data: { name: existing.name, enabled: false },
    });
    return await toDirectoryView(row);
  }
  const input = parseDirectoryUpdate(body, existing);
  const row = await appDb.transaction(async (tx) => {
    await assertNameAvailable(input.name, id);
    return (await first(tx
      .update(ldapDirectories)
      .set({ ...columns(input), updatedAt: nowIso() })
      .where(eq(ldapDirectories.id, id))
      .returning()))!;
  });

  const before = rowSettings(existing);
  // New connection settings or service account: the next check starts over.
  if (input.url !== before.url || input.startTls !== before.startTls || input.allowUnencrypted !== before.allowUnencrypted ||
      input.caCertificate !== before.caCertificate || input.bindDn !== before.bindDn || input.bindPassword !== undefined ||
      input.userSearchBase !== before.userSearchBase) {
    await clearDirectoryHealth(id);
  }
  const changes: string[] = [];
  if (input.enabled !== existing.enabled) changes.push(input.enabled ? "enabled" : "disabled");
  if (input.name !== existing.name) changes.push("name");
  if (input.url !== before.url || input.startTls !== before.startTls || input.allowUnencrypted !== before.allowUnencrypted ||
      input.caCertificate !== before.caCertificate) changes.push("connection");
  if (input.bindDn !== before.bindDn || input.bindPassword !== undefined) changes.push("service account");
  if (JSON.stringify(input.groupRoleMappings) !== JSON.stringify(before.groupRoleMappings) ||
      input.defaultRole !== before.defaultRole || input.requiredGroup !== before.requiredGroup) changes.push("roles");
  if (input.provisionUsers !== before.provisionUsers || input.linkExistingAccounts !== before.linkExistingAccounts) changes.push("accounts");
  if (input.allowWhenSsoEnforced !== before.allowWhenSsoEnforced) {
    changes.push(input.allowWhenSsoEnforced ? "open while SSO is enforced" : "closed while SSO is enforced");
  }
  await logAuditEvent({
    userId: actorUserId,
    action: "ldap_directory_updated",
    entityType: "ldap_directory",
    entityId: id,
    summary: `Updated LDAP directory "${input.name}"${changes.length ? `: ${changes.join(", ")}` : ""}`,
    data: { ...auditData(input), bindPasswordChanged: input.bindPassword !== undefined },
  });
  return await toDirectoryView(row);
}

/**
 * The accounts signed in through the directory are
 * unlinked in the same transaction (foreign keys are not enforced); the
 * users themselves are kept, and those without another way to sign in can
 * no longer sign in until an administrator gives them one.
 */
export async function deleteDirectory(id: number, actorUserId: number): Promise<void> {
  const existing = await requireDirectoryRow(id);
  const providerId = ldapProviderId(id);
  const unlinked = await appDb.transaction(async (tx) => {
    const rows = await tx
      .delete(accounts)
      .where(eq(accounts.providerId, providerId))
      .returning({ userId: accounts.userId });
    await tx.delete(ldapDirectories).where(eq(ldapDirectories.id, id));
    await clearDirectoryHealth(id, tx);
    return [...new Set(rows.map((row) => row.userId))];
  });
  // Keep users.provider/subject in step with the accounts that are left (#261).
  const { syncUserOAuthIdentity } = await import("@/src/lib/models/user");
  for (const userId of unlinked) {
    try {
      await syncUserOAuthIdentity(userId);
    } catch (error) {
      console.warn(`[ldap] Failed to update the sign-in method shown for user ${userId}:`, error);
    }
  }
  await logAuditEvent({
    userId: actorUserId,
    action: "ldap_directory_deleted",
    entityType: "ldap_directory",
    entityId: id,
    summary: `Deleted LDAP directory "${existing.name}" and unlinked ${unlinked.length} account${unlinked.length === 1 ? "" : "s"}`,
    data: { name: existing.name, url: existing.url, unlinkedUserIds: unlinked },
  });
}
