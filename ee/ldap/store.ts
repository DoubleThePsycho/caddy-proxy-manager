// SPDX-License-Identifier: Elastic-2.0
/**
 * Reading stored directories, for sign-in and for the administration code.
 * Nothing here looks at the license: sign-in through a directory that is
 * already set up keeps working without one.
 */
import { eq } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { ldapDirectories } from "@/src/lib/db/schema";
import { decryptSecret } from "@/src/lib/secret";
import { GROUP_MODES, LDAP_ROLES, type GroupMode } from "./constants";
import { DirectoryTransportError } from "./connection";
import type { DirectoryConfig, GroupRoleMapping } from "./types";
import { first } from "@/src/lib/db/ops";

export type LdapDirectoryRow = typeof ldapDirectories.$inferSelect;

/** A directory's settings without its id and service account password. */
export type DirectorySettings = Omit<DirectoryConfig, "id" | "bindPassword">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readStoredMappings(raw: string): GroupRoleMapping[] {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is GroupRoleMapping =>
        isRecord(item) && typeof item.group === "string" && typeof item.role === "string" &&
        (LDAP_ROLES as readonly string[]).includes(item.role)
    );
  } catch {
    return [];
  }
}

function storedGroupMode(value: string): GroupMode {
  return (GROUP_MODES as readonly string[]).includes(value) ? value as GroupMode : "none";
}

/** The stored row as validated settings (the starting point of an update). */
export function rowSettings(row: LdapDirectoryRow): DirectorySettings {
  return {
    name: row.name,
    enabled: row.enabled,
    url: row.url,
    startTls: row.startTls,
    allowUnencrypted: row.allowUnencrypted,
    caCertificate: row.caCertificate,
    connectTimeoutMs: row.connectTimeoutMs,
    operationTimeoutMs: row.operationTimeoutMs,
    bindDn: row.bindDn,
    userSearchBase: row.userSearchBase,
    userSearchFilter: row.userSearchFilter,
    usernameAttribute: row.usernameAttribute,
    emailAttribute: row.emailAttribute,
    displayNameAttribute: row.displayNameAttribute,
    uniqueIdAttribute: row.uniqueIdAttribute,
    groupMode: storedGroupMode(row.groupMode),
    groupMembershipAttribute: row.groupMembershipAttribute,
    groupSearchBase: row.groupSearchBase,
    groupSearchFilter: row.groupSearchFilter,
    nestedGroups: row.nestedGroups,
    groupRoleMappings: readStoredMappings(row.groupRoleMappings),
    defaultRole: row.defaultRole === "viewer" ? "viewer" : "user",
    requiredGroup: row.requiredGroup,
    provisionUsers: row.provisionUsers,
    linkExistingAccounts: row.linkExistingAccounts,
    allowWhenSsoEnforced: row.allowWhenSsoEnforced,
  };
}

export async function getDirectoryRow(id: number): Promise<LdapDirectoryRow | null> {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  return await first(appDb.select().from(ldapDirectories).where(eq(ldapDirectories.id, id)).limit(1)) ?? null;
}

/** The directory as sign-in uses it, with the service account password decrypted. */
export function toDirectoryConfig(row: LdapDirectoryRow): DirectoryConfig {
  let bindPassword: string;
  try {
    bindPassword = decryptSecret(row.bindPassword, `LDAP directory ${row.id} service account password`);
  } catch {
    throw new DirectoryTransportError(
      "The stored service account password cannot be decrypted with SESSION_SECRET; enter it again"
    );
  }
  return { id: row.id, ...rowSettings(row), bindPassword };
}
