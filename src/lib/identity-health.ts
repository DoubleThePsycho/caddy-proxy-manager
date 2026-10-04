/**
 * What needs attention in how people sign in, for the overview's "Needs
 * attention" list: LDAP directories that fail their periodic connection
 * check (ee/ldap/health.ts) and accounts the MFA policy has locked out of the
 * dashboard until they set up MFA. Reads stored state only; it never
 * connects to anything and never checks the license.
 */
import { eq } from "drizzle-orm";
import { appDb } from "./db";
import { ldapDirectories } from "./db/schema";
import { listMfaAccountSummaries } from "./mfa";
import { readAllDirectoryHealth, type DirectoryHealth } from "@/ee/ldap/health";
import { asc } from "@/src/lib/db/ops";

/** Failed checks in a row (5 minutes apart) after which a failing directory is critical. */
export const CRITICAL_DIRECTORY_FAILURES = 3;

export type DirectoryHealthSummary = {
  id: number;
  name: string;
  /** null: not checked yet. */
  health: DirectoryHealth | null;
};

export type IdentityIssue =
  | {
      kind: "directory_failing";
      severity: "warning" | "critical";
      directoryId: number;
      name: string;
      failingSince: string | null;
      consecutiveFailures: number;
      lastError: string | null;
      message: string;
    }
  | {
      kind: "mfa_overdue";
      severity: "warning";
      /** Accounts past the policy's deadline without MFA: their dashboard sessions can only set it up. */
      accounts: number;
      message: string;
    };

export type IdentityHealth = {
  /** Every enabled directory and its last check. */
  directories: DirectoryHealthSummary[];
  /** What needs attention, most severe first. */
  issues: IdentityIssue[];
};

export async function getIdentityHealth(): Promise<IdentityHealth> {
  const health = await readAllDirectoryHealth();
  const directories: DirectoryHealthSummary[] = (await appDb
    .select({ id: ldapDirectories.id, name: ldapDirectories.name })
    .from(ldapDirectories)
    .where(eq(ldapDirectories.enabled, true))
    .orderBy(asc(ldapDirectories.name), asc(ldapDirectories.id)))
    .map((row) => ({ ...row, health: health.get(row.id) ?? null }));

  const issues: IdentityIssue[] = [];
  for (const directory of directories) {
    if (directory.health?.status !== "failing") continue;
    const failures = directory.health.consecutiveFailures;
    issues.push({
      kind: "directory_failing",
      severity: failures >= CRITICAL_DIRECTORY_FAILURES ? "critical" : "warning",
      directoryId: directory.id,
      name: directory.name,
      failingSince: directory.health.failingSince,
      consecutiveFailures: failures,
      lastError: directory.health.lastError,
      message: `Directory "${directory.name}" fails its connection check; people cannot sign in through it.`,
    });
  }

  let overdue: number;
  try {
    overdue = (await listMfaAccountSummaries()).filter((account) => account.gate === "required").length;
  } catch {
    overdue = 0;
  }
  if (overdue > 0) {
    issues.push({
      kind: "mfa_overdue",
      severity: "warning",
      accounts: overdue,
      message: overdue === 1
        ? "1 account has not set up the multi-factor authentication the policy requires."
        : `${overdue} accounts have not set up the multi-factor authentication the policy requires.`,
    });
  }

  const rank = { critical: 0, warning: 1 } as const;
  issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { directories, issues };
}
