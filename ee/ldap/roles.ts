// SPDX-License-Identifier: Elastic-2.0
/**
 * Group-to-role mapping. The explicit mapping is the only way a directory
 * grants a role: no attribute of the entry (one named "role" included) is
 * ever read for it. Group DNs are compared case-insensitively, ignoring the
 * spaces RFC 4514 lets servers add around separators (normalizeDn).
 */
import { LDAP_ROLES, type LdapRole } from "./constants";
import { normalizeDn } from "./filter";
import type { DirectoryConfig } from "./types";

/** Higher wins when a user is in several mapped groups. */
const RANK: Record<LdapRole, number> = { viewer: 1, user: 2, admin: 3 };

export type RoleDecision = {
  /** The user is in the required group, or the directory requires none. */
  inRequiredGroup: boolean;
  /** The directory decides the user's role: it has at least one mapping. */
  managesRoles: boolean;
  /** The role the mapping gives (the default role when no mapped group matches). */
  role: LdapRole;
  /** The mapped groups the user is in. */
  matchedGroups: string[];
};

export function resolveDirectoryRole(
  config: Pick<DirectoryConfig, "groupRoleMappings" | "defaultRole" | "requiredGroup">,
  groups: readonly string[] | null
): RoleDecision {
  const memberOf = new Set((groups ?? []).map(normalizeDn));
  const inRequiredGroup = !config.requiredGroup || memberOf.has(normalizeDn(config.requiredGroup));
  let role: LdapRole | null = null;
  const matchedGroups: string[] = [];
  for (const mapping of config.groupRoleMappings) {
    if (!(LDAP_ROLES as readonly string[]).includes(mapping.role)) continue;
    if (!memberOf.has(normalizeDn(mapping.group))) continue;
    matchedGroups.push(mapping.group);
    if (role === null || RANK[mapping.role] > RANK[role]) role = mapping.role;
  }
  return {
    inRequiredGroup,
    managesRoles: config.groupRoleMappings.length > 0,
    role: role ?? config.defaultRole,
    matchedGroups,
  };
}
