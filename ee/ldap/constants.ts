// SPDX-License-Identifier: Elastic-2.0
/**
 * LDAP / Active Directory sign-in (feature "ldap"): names and limits shared by
 * the sign-in path, Better Auth's hooks and the administration code. Nothing
 * here touches the database or the license, so src/lib can import it.
 */

export const LDAP_FEATURE = "ldap" as const;

/** The Better Auth endpoint (under /api/auth) that signs a user in with a directory. */
export const LDAP_SIGN_IN_PATH = "/sign-in/ldap";

/**
 * Accounts signed in through directory `id` are `accounts` rows with this
 * providerId. The colon cannot occur in an OAuth provider id (a UUID, or a
 * slug of [a-z0-9-] for one configured through the environment), so a
 * directory and an OAuth provider never share a namespace.
 */
const PROVIDER_PREFIX = "ldap:";

export function ldapProviderId(directoryId: number): string {
  return `${PROVIDER_PREFIX}${directoryId}`;
}

export function isLdapProviderId(providerId: string | null | undefined): providerId is string {
  return typeof providerId === "string" && providerId.startsWith(PROVIDER_PREFIX);
}

/** The directory id in an accounts.providerId, or null for any other provider. */
export function parseLdapProviderId(providerId: string | null | undefined): number | null {
  if (!isLdapProviderId(providerId)) return null;
  const rest = providerId.slice(PROVIDER_PREFIX.length);
  if (!/^[1-9]\d{0,9}$/.test(rest)) return null;
  const id = Number(rest);
  // Ids are 32-bit integers (MAX_ROW_ID in src/lib/row-ids.ts).
  return id <= 2_147_483_647 ? id : null;
}

/**
 * accounts.issuer of a directory account. Distinct from the credential
 * namespace ("local:credential") and the OAuth one ("local:oauth:..."); see
 * src/lib/account-issuer.ts.
 */
export function ldapAccountIssuer(directoryId: number): string {
  return `local:ldap:${directoryId}`;
}

/** Accounts never linked, provisioned over or given a role by a directory: see protectedAccountIds. */
export const PRIMARY_ADMIN_USER_ID = 1;

export const LDAP_ROLES = ["admin", "user", "viewer"] as const;
export type LdapRole = (typeof LDAP_ROLES)[number];

/** Roles a user in none of the mapped groups may get: never admin. */
export const LDAP_DEFAULT_ROLES = ["user", "viewer"] as const;

export const GROUP_MODES = ["none", "member_of", "search"] as const;
export type GroupMode = (typeof GROUP_MODES)[number];

/** Active Directory's LDAP_MATCHING_RULE_IN_CHAIN, for nested group membership. */
export const MATCHING_RULE_IN_CHAIN = "1.2.840.113556.1.4.1941";

export const LIMITS = {
  name: 100,
  url: 512,
  dn: 1024,
  filter: 1024,
  attribute: 64,
  caCertificate: 64 * 1024,
  bindPassword: 1024,
  /** Typed username at sign-in. */
  username: 256,
  /** Typed password at sign-in. */
  password: 1024,
  /** Values read from an entry. */
  value: 1024,
  email: 254,
  displayName: 256,
  uniqueId: 256,
  /** Group memberships per user, read or searched; more fails closed. */
  groups: 1000,
  mappings: 100,
  minConnectTimeoutMs: 1000,
  maxConnectTimeoutMs: 60_000,
  minOperationTimeoutMs: 1000,
  maxOperationTimeoutMs: 120_000,
} as const;
