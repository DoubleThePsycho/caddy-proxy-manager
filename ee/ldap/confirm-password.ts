// SPDX-License-Identifier: Elastic-2.0
/**
 * Confirming a directory password for an account that has no local one.
 *
 * Better Auth's two-factor plugin asks for the account password before MFA
 * is turned on or off and before new backup codes are made. An account that
 * signs in only through a directory has no local password; it confirms with
 * its directory password instead (src/lib/mfa-auth.ts calls this). The entry
 * is found by the link's stable unique id and checked exactly like a
 * sign-in, through every enabled directory the account is linked to.
 */
import { and, eq } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { ldapDirectories } from "@/src/lib/db/schema";
import { verifyLinkedEntryPassword } from "./authenticate";
import { toDirectoryConfig } from "./store";
import { listDirectoryLinks } from "./identity";
import { beginDirectoryAttempt, confirmationAccountKey } from "./limiter";
import { first } from "@/src/lib/db/ops";

export type ConfirmationResult = "confirmed" | "refused" | "rate_limited";

export async function confirmDirectoryPassword(userId: number, password: string, ip: string): Promise<ConfirmationResult> {
  if (typeof password !== "string" || !password.trim()) return "refused";
  const links = await listDirectoryLinks(appDb, userId);
  if (links.length === 0) return "refused";
  const attempt = await beginDirectoryAttempt(confirmationAccountKey(userId), ip);
  if (!attempt) return "rate_limited";
  try {
    for (const link of links) {
      const row = await first(appDb
        .select()
        .from(ldapDirectories)
        .where(and(eq(ldapDirectories.id, link.directoryId), eq(ldapDirectories.enabled, true)))
        .limit(1));
      if (!row) continue;
      let confirmed = false;
      try {
        confirmed = await verifyLinkedEntryPassword(toDirectoryConfig(row), link.accountId, password);
      } catch {
        confirmed = false;
      }
      if (confirmed) {
        await attempt.succeed();
        return "confirmed";
      }
    }
    await attempt.fail();
    return "refused";
  } finally {
    await attempt.release();
  }
}
