// SPDX-License-Identifier: Elastic-2.0
/**
 * Enforced SSO on the sign-in path. Called from Better Auth's hooks in
 * src/lib/auth-server.ts.
 */
import { SAML_ACS_PATH } from "@/ee/saml/constants";
import { canAnyBreakGlassSignIn, describeBreakGlassAccounts, readSsoEnforcement, type SsoReader } from "./enforcement-store";

/**
 * Better Auth endpoints (route templates, as hooks see them) that sign a user
 * in through an identity provider. Every other endpoint that creates a
 * session (password sign-in by username or email, self-registration, and any
 * endpoint a future plugin adds) is refused while SSO is enforced, unless the
 * account is a break-glass account.
 *
 * - /callback/:id: the OAuth/OIDC redirect callback (generic OAuth providers
 *   are registered as social providers and come back here).
 * - /sign-in/social: social sign-in; it only creates a session itself for an
 *   ID token the provider has verified.
 * - /saml/acs/:providerId: the SAML assertion consumer service (ee/saml). It
 *   creates a session only after the signed response was verified for the
 *   sign-in this browser started (ee/saml/plugin.ts).
 */
export const SSO_SESSION_PATHS: ReadonlySet<string> = new Set(["/callback/:id", "/sign-in/social", SAML_ACS_PATH]);

export async function isSsoEnforced(reader: SsoReader): Promise<boolean> {
  return (await readSsoEnforcement(reader)).enabled;
}

/**
 * Enforced SSO as the login page shows it: whether it is on, and whether a
 * break-glass account can sign in with a password. Enforced without one, the
 * login page offers no password or passkey sign-in for local accounts.
 */
export async function loginPageEnforcement(reader: SsoReader): Promise<{ enforced: boolean; breakGlass: boolean }> {
  const config = await readSsoEnforcement(reader);
  if (!config.enabled) return { enforced: false, breakGlass: false };
  return { enforced: true, breakGlass: canAnyBreakGlassSignIn(await describeBreakGlassAccounts(reader, config.breakGlassUserIds)) };
}

/**
 * Whether Better Auth may create a session for `userId` on endpoint `path`
 * (undefined when no endpoint is running). Allowed when SSO is not enforced,
 * when the endpoint is an SSO sign-in, or when the account is a break-glass
 * account. The decision uses the authenticated account, not what the request
 * typed, so the username and email variants of password sign-in behave alike.
 */
export async function isSessionAllowedUnderSsoEnforcement(
  reader: SsoReader,
  userId: number,
  path: string | undefined
): Promise<boolean> {
  const config = await readSsoEnforcement(reader);
  if (!config.enabled) return true;
  if (path !== undefined && SSO_SESSION_PATHS.has(path)) return true;
  return config.breakGlassUserIds.includes(userId);
}
