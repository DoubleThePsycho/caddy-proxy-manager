// SPDX-License-Identifier: Elastic-2.0
/**
 * Group-to-role mapping for SAML sign-in. The explicit mapping is the only
 * way an assertion grants a role: no attribute (one named "role" included)
 * is ever read for it. Group values are compared exactly as the identity
 * provider sends them (Entra ID sends object IDs, Okta and Keycloak names or
 * paths), after trimming surrounding whitespace.
 */
import { SAML_ROLES, type SamlRole } from "./constants";
import type { SamlProviderConfig } from "./types";

/** Higher wins when a user is in several mapped groups. */
const RANK: Record<SamlRole, number> = { viewer: 1, user: 2, admin: 3 };

export type SamlRoleDecision = {
  /** The user has the required group, or the provider requires none. */
  inRequiredGroup: boolean;
  /** The provider decides the user's role: it has at least one mapping. */
  managesRoles: boolean;
  /** The role the mapping gives (the default role when no mapped group matches). */
  role: SamlRole;
  /** The mapped groups the user has. */
  matchedGroups: string[];
};

export function resolveSamlRole(
  config: Pick<SamlProviderConfig, "groupRoleMappings" | "defaultRole" | "requiredGroup">,
  groups: readonly string[]
): SamlRoleDecision {
  const memberOf = new Set(groups.map((group) => group.trim()));
  const inRequiredGroup = !config.requiredGroup || memberOf.has(config.requiredGroup.trim());
  let role: SamlRole | null = null;
  const matchedGroups: string[] = [];
  for (const mapping of config.groupRoleMappings) {
    if (!(SAML_ROLES as readonly string[]).includes(mapping.role)) continue;
    if (!memberOf.has(mapping.group.trim())) continue;
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
