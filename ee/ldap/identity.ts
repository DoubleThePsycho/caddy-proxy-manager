// SPDX-License-Identifier: Elastic-2.0
/**
 * What the database says about a user's directory accounts. Reads that take
 * the database or a transaction, so the MFA policy
 * (src/lib/mfa.ts) and Better Auth's session hook can use them.
 */
import { and, eq, inArray } from "drizzle-orm";
import { accounts, ldapDirectories } from "@/src/lib/db/schema";
import { readSsoEnforcement } from "@/ee/sso/enforcement-store";
import { PRIMARY_ADMIN_USER_ID, parseLdapProviderId } from "./constants";
import { likeText } from "@/src/lib/db/ops";
import type { DbExecutor } from "@/src/lib/db/types";

export type DirectoryReader = Pick<DbExecutor, "select">;

/** Directory accounts (directory id and stable unique id) linked to a user. */
export async function listDirectoryLinks(reader: DirectoryReader, userId: number): Promise<Array<{ directoryId: number; accountId: string }>> {
  return (await reader
    .select({ providerId: accounts.providerId, accountId: accounts.accountId })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), likeText(accounts.providerId, "ldap:%"))))
    .flatMap((row) => {
      const directoryId = parseLdapProviderId(row.providerId);
      return directoryId === null ? [] : [{ directoryId, accountId: row.accountId }];
    });
}

/**
 * The enabled directories a user is linked to, and with `whileSsoEnforced`
 * only those that stay open while enforced SSO is on.
 */
export async function usableDirectoryIds(
  reader: DirectoryReader,
  userId: number,
  options: { whileSsoEnforced: boolean }
): Promise<number[]> {
  const ids = [...new Set((await listDirectoryLinks(reader, userId)).map((link) => link.directoryId))];
  if (ids.length === 0) return [];
  return (await reader
    .select({ id: ldapDirectories.id, allow: ldapDirectories.allowWhenSsoEnforced })
    .from(ldapDirectories)
    .where(and(inArray(ldapDirectories.id, ids), eq(ldapDirectories.enabled, true))))
    .filter((row) => !options.whileSsoEnforced || row.allow)
    .map((row) => row.id);
}

/** The user is linked to an enabled directory, so a directory password is a way in (and can confirm MFA changes). */
export async function hasDirectoryPassword(reader: DirectoryReader, userId: number): Promise<boolean> {
  return (await usableDirectoryIds(reader, userId, { whileSsoEnforced: false })).length > 0;
}

/**
 * Whether the user can sign in with a directory password now: linked to an
 * enabled directory that, while enforced SSO is on, stays open under it.
 * The MFA policy counts this as signing in with a password.
 */
export async function canSignInWithDirectory(reader: DirectoryReader, userId: number): Promise<boolean> {
  const ssoEnforced = (await readSsoEnforcement(reader)).enabled;
  return (await usableDirectoryIds(reader, userId, { whileSsoEnforced: ssoEnforced })).length > 0;
}

/**
 * Accounts a directory never links, provisions over or changes the role of:
 * the primary admin (created from ADMIN_USERNAME with id 1, see init-db.ts)
 * and every break-glass account of enforced SSO, whether or not enforcement
 * is on.
 */
export async function protectedUserIds(reader: DirectoryReader): Promise<Set<number>> {
  return new Set([PRIMARY_ADMIN_USER_ID, ...(await readSsoEnforcement(reader)).breakGlassUserIds]);
}
