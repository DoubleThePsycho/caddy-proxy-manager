// SPDX-License-Identifier: Elastic-2.0
/**
 * Directory sign-in and enforced SSO (ee/sso).
 *
 * Directory sign-in checks a password, so enforced SSO refuses it like any
 * other password sign-in, unless the directory has "allow while SSO is
 * enforced" turned on (off by default). Break-glass accounts keep their local
 * password; they get no exception for directory sign-in.
 *
 * Better Auth's session hook (src/lib/auth-server.ts) asks
 * isDirectorySessionAllowedUnderSsoEnforcement on top of the SSO allowlist:
 *  - on the directory sign-in endpoint, only for the user and directory the
 *    endpoint is signing in right now (runDirectorySignIn), and only while
 *    that directory is enabled and open under enforcement;
 *  - on the second-factor step (/two-factor/verify-*), for a user linked to
 *    such a directory. A sign-in challenge exists only after a first step
 *    the same hook allowed, and a password sign-in of a user who is not a
 *    break-glass account is refused before any challenge, so this admits
 *    exactly the directory sign-ins that passed the first step.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq } from "drizzle-orm";
import { ldapDirectories } from "@/src/lib/db/schema";
import { readSsoEnforcement } from "@/ee/sso/enforcement-store";
import { LDAP_SIGN_IN_PATH } from "./constants";
import { usableDirectoryIds, type DirectoryReader } from "./identity";
import { asc, first } from "@/src/lib/db/ops";

/** The second sign-in step of Better Auth's two-factor plugin (MFA_VERIFY_PATHS in src/lib/mfa-auth.ts). */
const SECOND_FACTOR_PATHS: ReadonlySet<string> = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code"]);

type DirectorySignIn = { userId: number; directoryId: number };

const currentSignIn = new AsyncLocalStorage<DirectorySignIn>();

/** Runs `fn` (which creates the session) as the directory sign-in of `userId` through `directoryId`. */
export function runDirectorySignIn<T>(signIn: DirectorySignIn, fn: () => Promise<T>): Promise<T> {
  return currentSignIn.run(signIn, fn);
}

async function directoryOpenUnderSso(reader: DirectoryReader, directoryId: number): Promise<boolean> {
  const row = await first(reader
    .select({ id: ldapDirectories.id })
    .from(ldapDirectories)
    .where(and(
      eq(ldapDirectories.id, directoryId),
      eq(ldapDirectories.enabled, true),
      eq(ldapDirectories.allowWhenSsoEnforced, true)
    ))
    .limit(1));
  return !!row;
}

/** Whether a directory may be used to sign in now, given enforced SSO. */
export function isDirectoryOpen(directory: { enabled: boolean; allowWhenSsoEnforced: boolean }, ssoEnforced: boolean): boolean {
  return directory.enabled && (!ssoEnforced || directory.allowWhenSsoEnforced);
}

/**
 * Whether Better Auth may create a session for `userId` on `path` while SSO
 * is enforced because it is a directory sign-in a directory allows. Only
 * consulted when the SSO allowlist refused it.
 */
export async function isDirectorySessionAllowedUnderSsoEnforcement(
  reader: DirectoryReader,
  userId: number,
  path: string | undefined
): Promise<boolean> {
  if (path === LDAP_SIGN_IN_PATH) {
    const signIn = currentSignIn.getStore();
    return !!signIn && signIn.userId === userId && await directoryOpenUnderSso(reader, signIn.directoryId);
  }
  if (path !== undefined && SECOND_FACTOR_PATHS.has(path)) {
    return (await usableDirectoryIds(reader, userId, { whileSsoEnforced: true })).length > 0;
  }
  return false;
}

/** The directories the login page offers: enabled ones, and while SSO is enforced only those open under it. */
export async function listLoginDirectories(reader: DirectoryReader): Promise<Array<{ id: number; name: string }>> {
  const ssoEnforced = (await readSsoEnforcement(reader)).enabled;
  return (await reader
    .select({ id: ldapDirectories.id, name: ldapDirectories.name, enabled: ldapDirectories.enabled, allow: ldapDirectories.allowWhenSsoEnforced })
    .from(ldapDirectories)
    .where(eq(ldapDirectories.enabled, true))
    .orderBy(asc(ldapDirectories.name), asc(ldapDirectories.id)))
    .filter((row) => isDirectoryOpen({ enabled: row.enabled, allowWhenSsoEnforced: row.allow }, ssoEnforced))
    .map((row) => ({ id: row.id, name: row.name }));
}
