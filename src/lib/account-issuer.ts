/**
 * Account namespace ("issuer") helpers for Ingressi's `accounts` table.
 *
 * Better Auth 1.7 namespaced external identities by `(issuer, accountId)` and
 * exposed `createLocalAccountIssuer` / `createOAuthAccountIssuer` to build those
 * synthetic issuers. Starting with Better Auth 1.7.4 the account key is
 * `(providerId, accountId)` and the issuer helpers were removed from
 * `better-auth/db`; Ingressi keeps its own `accounts.issuer` column for its internal
 * identity bookkeeping, so the namespace strings are computed here and are
 * deliberately identical to the values Better Auth 1.7.x produced. A provider
 * with its own issuer stays pinned to it (trusted config wins); providers
 * without one get an isolated URL-encoded synthetic namespace so they cannot
 * collide with each other or with the local credential account.
 */

function encodeIssuerProviderId(providerId: string): string {
  return encodeURIComponent(providerId);
}

/**
 * Builds the synthetic issuer used by providers without an issuer of their own.
 */
export function createLocalAccountIssuer(providerId: string): string {
  return `local:${encodeIssuerProviderId(providerId)}`;
}

/**
 * Builds the synthetic issuer used by OAuth providers without an issuer of
 * their own. OAuth identities use a distinct namespace so a provider ID cannot
 * collide with an internal local authentication method.
 */
export function createOAuthAccountIssuer(providerId: string): string {
  return `local:oauth:${encodeIssuerProviderId(providerId)}`;
}

/** Ingressi's stable namespace for password-backed (credential) accounts. */
export const CREDENTIAL_ACCOUNT_ISSUER = createLocalAccountIssuer("credential");

/**
 * Resolve the identity namespace used for a configured OAuth provider.
 *
 * Prefer the operator-configured issuer when present. Providers without an
 * issuer stay isolated by the synthetic, URL-encoded provider namespace so they
 * cannot collide with local authentication methods.
 */
export function resolveOAuthAccountIssuer(
  providerId: string,
  configuredIssuer?: string | null
): string {
  const issuer = configuredIssuer?.trim();
  return issuer || createOAuthAccountIssuer(providerId);
}
