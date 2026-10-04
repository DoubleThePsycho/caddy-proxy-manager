// SPDX-License-Identifier: Elastic-2.0
/**
 * Directory health: every 5 minutes each enabled directory is checked the way
 * the "Test the connection" button does it (connect with TLS as configured,
 * bind as the service account, read the user search base), each step with
 * the directory's own timeouts and the whole check with an overall one.
 *
 * The result is stored per directory (ldap_directory_health): status, when it
 * was last checked and last succeeded, the last error (the same description
 * a connection test shows; it never contains a password) and how many checks
 * in a row failed. The LDAP REST API returns it with each directory and
 * getIdentityHealth (src/lib/identity-health.ts) reports failing ones to the
 * overview. Only changes of state are audited: a directory that starts
 * failing (ldap_directory_unavailable) and one that works again
 * (ldap_directory_recovered).
 *
 * A runtime path: it never checks the license, like directory sign-in.
 * Directories are per dashboard (not synced), so each dashboard checks its own.
 */
import { eq } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { ldapDirectories, ldapDirectoryHealth } from "@/src/lib/db/schema";
import { logAuditEvent } from "@/src/lib/audit";
import { testDirectoryConnection, type ConnectionTestResult } from "./authenticate";
import { describeDirectoryError } from "./connection";
import { toDirectoryConfig, type LdapDirectoryRow } from "./store";
import { asc, first } from "@/src/lib/db/ops";
import type { AppDb } from "@/src/lib/db/types";
import { onShutdown } from "@/src/lib/shutdown";

export const DIRECTORY_HEALTH_INTERVAL_MS = 5 * 60_000;
/** Lets the other startup work settle before the first check. */
const FIRST_CHECK_DELAY_MS = 30_000;
/** Longest error text kept. */
const MAX_ERROR_LENGTH = 500;

export type DirectoryHealthStatus = "ok" | "failing";

export type DirectoryHealth = {
  status: DirectoryHealthStatus;
  checkedAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** When the current run of failures started; null while the directory works. */
  failingSince: string | null;
  /** The last failure, e.g. "Service account bind: invalid credentials (LDAP result 49)". */
  lastError: string | null;
  consecutiveFailures: number;
};

const STEP_LABELS: Record<ConnectionTestResult["steps"][number]["step"], string> = {
  connect: "Connect",
  bind: "Service account bind",
  search_base: "User search base",
};

/** The error text of a failed connection test: the step that failed and why. */
export function describeFailedCheck(result: ConnectionTestResult): string {
  const failed = result.steps.find((step) => !step.ok);
  if (!failed) return "The check failed";
  return `${STEP_LABELS[failed.step] ?? failed.step}: ${failed.detail}`.slice(0, MAX_ERROR_LENGTH);
}

type HealthRow = typeof ldapDirectoryHealth.$inferSelect;

function toHealth(row: HealthRow): DirectoryHealth {
  return {
    status: row.status === "ok" ? "ok" : "failing",
    checkedAt: row.checkedAt,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    failingSince: row.failingSince,
    lastError: row.lastError,
    consecutiveFailures: row.consecutiveFailures,
  };
}

export async function readDirectoryHealth(directoryId: number): Promise<DirectoryHealth | null> {
  const row = await first(appDb.select().from(ldapDirectoryHealth).where(eq(ldapDirectoryHealth.directoryId, directoryId)).limit(1));
  return row ? toHealth(row) : null;
}

export async function readAllDirectoryHealth(): Promise<Map<number, DirectoryHealth>> {
  return new Map((await appDb.select().from(ldapDirectoryHealth)).map((row) => [row.directoryId, toHealth(row)]));
}

/** Forgets a directory's health: it was deleted, or its settings changed and the next check starts over. */
export async function clearDirectoryHealth(directoryId: number, tx: Pick<AppDb, "delete"> = appDb): Promise<void> {
  await tx.delete(ldapDirectoryHealth).where(eq(ldapDirectoryHealth.directoryId, directoryId));
}

/**
 * Stores the outcome of one check of `directory` and audits a change of
 * state. Returns the new health.
 */
export async function recordDirectoryHealth(
  directory: { id: number; name: string },
  outcome: { ok: true } | { ok: false; error: string },
  at: string = nowIso()
): Promise<DirectoryHealth> {
  // Read, write and audit the change of state in one transaction: two checks
  // finishing together audit it once.
  return await appDb.transaction(async () => {
    const previous = await readDirectoryHealth(directory.id);
    const next: DirectoryHealth = outcome.ok
      ? {
          status: "ok",
          checkedAt: at,
          lastSuccessAt: at,
          lastFailureAt: previous?.lastFailureAt ?? null,
          failingSince: null,
          lastError: previous?.lastError ?? null,
          consecutiveFailures: 0,
        }
      : {
          status: "failing",
          checkedAt: at,
          lastSuccessAt: previous?.lastSuccessAt ?? null,
          lastFailureAt: at,
          failingSince: previous?.status === "failing" ? previous.failingSince ?? at : at,
          lastError: outcome.error.slice(0, MAX_ERROR_LENGTH),
          consecutiveFailures: (previous?.status === "failing" ? previous.consecutiveFailures : 0) + 1,
        };
    await appDb.insert(ldapDirectoryHealth)
      .values({ directoryId: directory.id, ...next })
      .onConflictDoUpdate({ target: ldapDirectoryHealth.directoryId, set: next });

    if (next.status === "failing" && previous?.status !== "failing") {
      await logAuditEvent({
        userId: null,
        action: "ldap_directory_unavailable",
        entityType: "ldap_directory",
        entityId: directory.id,
        summary: `LDAP directory "${directory.name}" failed its connection check: ${next.lastError}`,
        data: { error: next.lastError },
      });
    } else if (next.status === "ok" && previous?.status === "failing") {
      await logAuditEvent({
        userId: null,
        action: "ldap_directory_recovered",
        entityType: "ldap_directory",
        entityId: directory.id,
        summary: `LDAP directory "${directory.name}" passes its connection check again after ${previous.consecutiveFailures} failed check${previous.consecutiveFailures === 1 ? "" : "s"}`,
        data: { failingSince: previous.failingSince, consecutiveFailures: previous.consecutiveFailures },
      });
    }
    return next;
  }, { behavior: "immediate" });
}

/** The longest one check may take: connecting, binding and searching, with some room. */
export function checkTimeoutMs(row: Pick<LdapDirectoryRow, "connectTimeoutMs" | "operationTimeoutMs">): number {
  return row.connectTimeoutMs + 2 * row.operationTimeoutMs + 5_000;
}

type Tester = (config: ReturnType<typeof toDirectoryConfig>) => Promise<ConnectionTestResult>;

/** Runs one check of `row` (enabled or not) and stores the outcome. */
export async function checkDirectoryHealth(row: LdapDirectoryRow, test: Tester = testDirectoryConnection): Promise<DirectoryHealth> {
  let outcome: { ok: true } | { ok: false; error: string };
  const timeoutMs = checkTimeoutMs(row);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const config = toDirectoryConfig(row);
    const result = await Promise.race([
      test(config),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CheckTimeoutError(timeoutMs)), timeoutMs);
        timer.unref?.();
      }),
    ]);
    outcome = result.ok ? { ok: true } : { ok: false, error: describeFailedCheck(result) };
  } catch (error) {
    outcome = {
      ok: false,
      error: error instanceof CheckTimeoutError ? error.message : `Connect: ${describeDirectoryError(error)}`,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
  return await recordDirectoryHealth({ id: row.id, name: row.name }, outcome);
}

class CheckTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The check did not finish within ${Math.round(timeoutMs / 1000)} seconds`);
    this.name = "CheckTimeoutError";
  }
}

const state = globalThis as typeof globalThis & {
  __ingressiDirectoryHealth?: { interval: ReturnType<typeof setInterval> | null; running: boolean };
};
const scheduler = (state.__ingressiDirectoryHealth ??= { interval: null, running: false });

/** Checks every enabled directory, one after the other. Skipped while a previous run is still going. */
export async function runDirectoryHealthChecks(test: Tester = testDirectoryConnection): Promise<{ checked: number; failing: number } | null> {
  if (scheduler.running) return null;
  scheduler.running = true;
  try {
    const rows = await appDb.select().from(ldapDirectories).where(eq(ldapDirectories.enabled, true)).orderBy(asc(ldapDirectories.id));
    let failing = 0;
    for (const row of rows) {
      const health = await checkDirectoryHealth(row, test);
      if (health.status === "failing") failing += 1;
    }
    return { checked: rows.length, failing };
  } finally {
    scheduler.running = false;
  }
}

function tick(): void {
  runDirectoryHealthChecks().catch((error) => {
    console.error("[ldap] Directory health checks failed:", error instanceof Error ? error.name : typeof error);
  });
}

/** The pending first run, so stopping (a PostgreSQL replica that stops leading) cancels it too. */
let firstRun: ReturnType<typeof setTimeout> | undefined;

/** Started from src/instrumentation.ts (never in tests). */
export function startDirectoryHealthChecks(): void {
  if (scheduler.interval) return;
  clearTimeout(firstRun);
  firstRun = setTimeout(tick, FIRST_CHECK_DELAY_MS);
  firstRun.unref?.();
  scheduler.interval = setInterval(tick, DIRECTORY_HEALTH_INTERVAL_MS);
  scheduler.interval.unref?.();
  onShutdown("stopping the directory health checks", stopDirectoryHealthChecks);
}

export function stopDirectoryHealthChecks(): void {
  clearTimeout(firstRun);
  firstRun = undefined;
  if (scheduler.interval) clearInterval(scheduler.interval);
  scheduler.interval = null;
}
