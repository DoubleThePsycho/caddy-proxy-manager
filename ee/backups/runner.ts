// SPDX-License-Identifier: Elastic-2.0
/**
 * Backup runs: build the passphrase-encrypted export file (the same file the
 * configuration export downloads), upload it, apply retention and record the
 * run. Also the connection test, the listing of stored backups and restore.
 *
 * Error messages stored in runs and shown in the UI come from S3Error (status
 * and S3 error code) or from application errors; they never contain
 * credentials, signed requests or response bodies.
 */
import { randomBytes } from "node:crypto";
import { and, count, eq, lt } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { backupDestinations, backupRuns } from "@/src/lib/db/schema";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiClientError, ApiConflictError, ApiValidationError } from "@/src/lib/api-errors";
import { BRAND_NAME } from "@/src/lib/brand";
import { assertConfigurationEditable, ConfigurationApplyError } from "@/src/lib/config-replace";
import { buildConfigurationExport, importConfiguration, MAX_IMPORT_BYTES } from "@/src/lib/config-transfer";
import { beforeImportSnapshotHook } from "@/ee/config-history/snapshots";
import {
  clientFor,
  getDestinationRow,
  objectPrefix,
  requireDestinationRow,
  storedPassphrase,
  type BackupDestinationRow,
} from "./destinations";
import { tryWithDestinationLock } from "./locks";
import { S3Error, type FetchLike, type S3Client } from "./s3";
import { nextRunAfter, readStoredSchedule } from "./schedule";
import { sha256Hex } from "./sigv4";
import {
  BACKUP_FILE_PATTERN,
  BACKUP_FILE_PREFIX,
  type BackupObjectsListing,
  type BackupRestoreResult,
  type BackupRunsPage,
  type BackupRunStatus,
  type BackupRunView,
  type BackupTestResult,
  type BackupTestStep,
  type BackupTrigger,
} from "./types";
import { asc, desc } from "@/src/lib/db/ops";

/** Injected in tests; production uses the global fetch and the clock. */
export type BackupDependencies = { fetch?: FetchLike; now?: () => Date };

const RETRY_BASE_MS = 5 * 60_000;
const RETRY_MAX_MS = 6 * 60 * 60_000;
const MAX_ERROR_LENGTH = 500;
/** Older backups deleted per run at most; the rest go on the next run. */
const MAX_DELETES_PER_RUN = 100;
const MAX_LISTED_OBJECTS = 1000;
export const MAX_RUNS_PER_DESTINATION = 200;
const TEST_OBJECT_MAX_BYTES = 64 * 1024;

type RunRow = typeof backupRuns.$inferSelect;

/** Delay before retrying a destination that failed `failures` times in a row (never later than its next scheduled run). */
export function retryDelayMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(RETRY_BASE_MS * 2 ** Math.min(failures - 1, 20), RETRY_MAX_MS);
}

/** ingressi-config-2026-10-02T03-00-00.123Z.json */
export function backupFileName(date: Date): string {
  return `${BACKUP_FILE_PREFIX}${date.toISOString().replace(/:/g, "-")}.json`;
}

/** Whether `key` is a backup file directly under the destination's prefix. */
export function isBackupKey(row: Pick<BackupDestinationRow, "keyPrefix">, key: string): boolean {
  const prefix = objectPrefix(row);
  return key.startsWith(prefix) && BACKUP_FILE_PATTERN.test(key.slice(prefix.length));
}

/** A message safe to store and show. Unexpected errors are logged by type only. */
export function describeBackupError(error: unknown): string {
  if (error instanceof S3Error || error instanceof ApiClientError) return error.message.slice(0, MAX_ERROR_LENGTH);
  console.error("[backups] Unexpected error:", error instanceof Error ? error.name : typeof error);
  return "Unexpected error; see the server log";
}

function toRunView(row: RunRow, destinationName: string | null): BackupRunView {
  return {
    id: row.id,
    destinationId: row.destinationId,
    destinationName,
    trigger: row.trigger === "manual" ? "manual" : "schedule",
    status: (["running", "success", "failed"] as const).includes(row.status as BackupRunStatus)
      ? (row.status as BackupRunStatus)
      : "failed",
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    objectKey: row.objectKey,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    prunedCount: row.prunedCount,
    error: row.error,
    warning: row.warning,
  };
}

/** Deletes backup files beyond the retention, oldest first; returns how many. */
export async function applyRetention(client: S3Client, row: BackupDestinationRow, uploadedKey: string | null): Promise<number> {
  const prefix = objectPrefix(row);
  const { objects } = await client.listObjects(`${prefix}${BACKUP_FILE_PREFIX}`);
  const keys = new Set(objects.map((object) => object.key).filter((key) => isBackupKey(row, key)));
  // A listing may not show the file just written yet.
  if (uploadedKey) keys.add(uploadedKey);
  // Names sort by time: newest first.
  const excess = [...keys]
    .sort()
    .reverse()
    .slice(row.retention)
    .filter((key) => key !== uploadedKey)
    .slice(0, MAX_DELETES_PER_RUN);
  let deleted = 0;
  for (const key of excess) {
    await client.deleteObject(key);
    deleted += 1;
  }
  return deleted;
}

async function pruneRuns(destinationId: number): Promise<void> {
  const [cutoff] = await appDb
    .select({ id: backupRuns.id })
    .from(backupRuns)
    .where(eq(backupRuns.destinationId, destinationId))
    .orderBy(desc(backupRuns.id))
    .limit(1)
    .offset(MAX_RUNS_PER_DESTINATION - 1);
  if (cutoff) {
    await appDb.delete(backupRuns).where(and(eq(backupRuns.destinationId, destinationId), lt(backupRuns.id, cutoff.id)));
  }
}

/** Updates the destination after a run: status, failure count and the next attempt. */
async function recordOutcome(destinationId: number, status: "success" | "failed", error: string | null, at: Date): Promise<void> {
  // Read again: the destination may have been changed or disabled meanwhile.
  const current = await getDestinationRow(destinationId);
  if (!current) return;
  const schedule = readStoredSchedule(current.schedule);
  const scheduled = nextRunAfter(schedule, current.timeZone, at);
  const stamp = at.toISOString();
  if (status === "success") {
    await appDb
      .update(backupDestinations)
      .set({
        lastRunAt: stamp,
        lastStatus: "success",
        lastError: null,
        lastSuccessAt: stamp,
        consecutiveFailures: 0,
        nextRunAt: current.enabled ? scheduled.toISOString() : null,
      })
      .where(eq(backupDestinations.id, destinationId));
    return;
  }
  const failures = current.consecutiveFailures + 1;
  const retryAt = new Date(Math.min(at.getTime() + retryDelayMs(failures), scheduled.getTime()));
  await appDb
    .update(backupDestinations)
    .set({
      lastRunAt: stamp,
      lastStatus: "failed",
      lastError: error,
      consecutiveFailures: failures,
      nextRunAt: current.enabled ? retryAt.toISOString() : null,
    })
    .where(eq(backupDestinations.id, destinationId));
}

/**
 * One backup to one destination. Throws a 409 when a backup to it is already
 * running (on any replica); every other failure is recorded in the run
 * (status "failed") and on the destination, which then retries with
 * backoff.
 */
export async function runBackup(destinationId: number, trigger: BackupTrigger, deps: BackupDependencies = {}): Promise<BackupRunView> {
  const run = await tryRunBackup(destinationId, trigger, deps);
  if (!run) throw new ApiConflictError("A backup to this destination is already running");
  return run;
}

/** runBackup, or null when a backup to the destination is already running. */
async function tryRunBackup(destinationId: number, trigger: BackupTrigger, deps: BackupDependencies): Promise<BackupRunView | null> {
  const outcome = await tryWithDestinationLock(destinationId, () => runBackupHoldingLock(destinationId, trigger, deps));
  return outcome.acquired ? outcome.value : null;
}

async function runBackupHoldingLock(destinationId: number, trigger: BackupTrigger, deps: BackupDependencies): Promise<BackupRunView> {
  const now = deps.now ?? (() => new Date());
  const row = await requireDestinationRow(destinationId);
  const [run] = await appDb
    .insert(backupRuns)
    .values({ destinationId, trigger, status: "running", startedAt: now().toISOString() })
    .returning();

  let outcome: Partial<RunRow> & { status: "success" | "failed" };
  let stage = "Backup failed";
  try {
    const passphrase = storedPassphrase(row);
    const client = clientFor(row, { fetch: deps.fetch, now });
    stage = "Could not build the export file";
    const { file } = await buildConfigurationExport(passphrase);
    const body = Buffer.from(JSON.stringify(file, null, 2), "utf8");
    const checksum = sha256Hex(body);
    const key = `${objectPrefix(row)}${backupFileName(new Date(file.exportedAt))}`;
    stage = "Upload failed";
    await client.putObject(key, body, { contentType: "application/json", metadata: { sha256: checksum } });
    let prunedCount: number | null = null;
    let warning: string | null = null;
    try {
      prunedCount = await applyRetention(client, row, key);
    } catch (error) {
      warning = `The backup was uploaded, but deleting older backups failed: ${describeBackupError(error)}`.slice(0, MAX_ERROR_LENGTH);
    }
    outcome = { status: "success", objectKey: key, sizeBytes: body.length, sha256: checksum, prunedCount, warning };
  } catch (error) {
    outcome = { status: "failed", error: `${stage}: ${describeBackupError(error)}`.slice(0, MAX_ERROR_LENGTH) };
  }

  const finishedAt = now();
  const [finished] = await appDb
    .update(backupRuns)
    .set({ ...outcome, finishedAt: finishedAt.toISOString() })
    .where(eq(backupRuns.id, run.id))
    .returning();
  await recordOutcome(destinationId, outcome.status, outcome.error ?? null, finishedAt);
  await pruneRuns(destinationId);
  return toRunView(finished ?? { ...run, ...outcome, finishedAt: finishedAt.toISOString() }, row.name);
}

/** "Back up now"; refused on a sync slave. */
export async function runBackupNow(destinationId: number, actorUserId: number, deps: BackupDependencies = {}): Promise<BackupRunView> {
  const row = await requireDestinationRow(destinationId);
  await assertConfigurationEditable();
  const run = await runBackup(destinationId, "manual", deps);
  await logAuditEvent({
    userId: actorUserId,
    action: "backup_run_manual",
    entityType: "backup_destination",
    entityId: destinationId,
    summary:
      run.status === "success"
        ? `Backed up the configuration to "${row.name}" (${run.objectKey})`
        : `Backing up the configuration to "${row.name}" failed: ${run.error}`,
    data: { runId: run.id, status: run.status, objectKey: run.objectKey, sizeBytes: run.sizeBytes, sha256: run.sha256 },
  });
  return run;
}

export type DueBackupsResult = { due: number; succeeded: number; failed: number };

const store = globalThis as typeof globalThis & { __ingressiBackupTick?: { running: boolean } };
const tick = (store.__ingressiBackupTick ??= { running: false });

/**
 * Runs every enabled destination whose next run is due, one after the other,
 * skipping those with a backup in progress (a "Back up now", or a run on
 * another replica), after marking the runs of stopped processes interrupted.
 * Returns null while the previous pass of this process is still running.
 */
export async function runDueBackups(deps: BackupDependencies = {}): Promise<DueBackupsResult | null> {
  if (tick.running) return null;
  tick.running = true;
  try {
    const now = (deps.now ?? (() => new Date()))();
    const result: DueBackupsResult = { due: 0, succeeded: 0, failed: 0 };
    try {
      await markInterruptedRuns(now);
    } catch (error) {
      console.error("[backups] Could not mark interrupted runs:", error instanceof Error ? error.name : typeof error);
    }
    const rows = await appDb.select().from(backupDestinations).where(eq(backupDestinations.enabled, true)).orderBy(asc(backupDestinations.id));
    for (const row of rows) {
      if (!row.nextRunAt) {
        const next = nextRunAfter(readStoredSchedule(row.schedule), row.timeZone, now).toISOString();
        await appDb.update(backupDestinations).set({ nextRunAt: next }).where(eq(backupDestinations.id, row.id));
        continue;
      }
      if (row.nextRunAt > now.toISOString()) continue;
      try {
        const run = await tryRunBackup(row.id, "schedule", deps);
        // Running already: the run in progress takes care of it.
        if (!run) continue;
        result.due += 1;
        if (run.status === "success") result.succeeded += 1;
        else result.failed += 1;
      } catch (error) {
        // A database error for one destination must not stop the others.
        result.due += 1;
        result.failed += 1;
        console.error(`[backups] Backup to destination ${row.id} failed:`, error instanceof Error ? error.name : typeof error);
      }
    }
    return result;
  } finally {
    tick.running = false;
  }
}

/**
 * Runs left "running" by a process that stopped, marked failed: at startup
 * and before every scheduled pass. A run counts as left behind only when
 * its destination's lock is free, so a backup in progress on another
 * replica is never marked. Returns how many were marked.
 */
export async function markInterruptedRuns(now: Date = new Date()): Promise<number> {
  const running = await appDb
    .selectDistinct({ destinationId: backupRuns.destinationId })
    .from(backupRuns)
    .where(eq(backupRuns.status, "running"))
    .orderBy(asc(backupRuns.destinationId));
  let marked = 0;
  for (const { destinationId } of running) {
    const outcome = await tryWithDestinationLock(destinationId, async () => {
      const rows = await appDb
        .update(backupRuns)
        .set({ status: "failed", error: "Interrupted: the server stopped during the backup", finishedAt: now.toISOString() })
        .where(and(eq(backupRuns.destinationId, destinationId), eq(backupRuns.status, "running")))
        .returning({ id: backupRuns.id });
      return rows.length;
    });
    if (outcome.acquired) marked += outcome.value;
  }
  return marked;
}

/** Writes, reads back and deletes a small object. */
export async function testBackupDestination(
  destinationId: number,
  actorUserId: number,
  deps: BackupDependencies = {}
): Promise<BackupTestResult> {
  const row = await requireDestinationRow(destinationId);
  const started = Date.now();
  const key = `${objectPrefix(row)}ingressi-connection-test-${randomBytes(8).toString("hex")}.txt`;
  const body = Buffer.from(`${BRAND_NAME} backup connection test, ${new Date().toISOString()}\n`, "utf8");
  let step: BackupTestStep = "write";
  let error: string | null = null;
  let client: S3Client | null = null;
  let written = false;
  try {
    client = clientFor(row, { fetch: deps.fetch, now: deps.now });
    await client.putObject(key, body, { contentType: "text/plain; charset=utf-8" });
    written = true;
    step = "read";
    const read = await client.getObject(key, TEST_OBJECT_MAX_BYTES);
    if (!read.body.equals(body)) throw new S3Error("The object read back differs from the one written");
    step = "delete";
    await client.deleteObject(key);
    written = false;
  } catch (failure) {
    error = describeBackupError(failure);
    if (written && client) await client.deleteObject(key).catch(() => undefined);
  }
  const result: BackupTestResult = {
    ok: error === null,
    error,
    failedStep: error === null ? null : step,
    durationMs: Date.now() - started,
  };
  await logAuditEvent({
    userId: actorUserId,
    action: "backup_destination_tested",
    entityType: "backup_destination",
    entityId: destinationId,
    summary: `Tested backup destination "${row.name}": ${result.ok ? "write, read and delete worked" : `${step} failed (${error})`}`,
    data: { ok: result.ok, failedStep: result.failedStep, error },
  });
  return result;
}

/** Backup files under the destination's prefix, newest first. */
export async function listBackupObjects(destinationId: number, deps: BackupDependencies = {}): Promise<BackupObjectsListing> {
  const row = await requireDestinationRow(destinationId);
  const client = clientFor(row, { fetch: deps.fetch, now: deps.now });
  const { objects, complete } = await client.listObjects(`${objectPrefix(row)}${BACKUP_FILE_PREFIX}`);
  const backups = objects
    .filter((object) => isBackupKey(row, object.key))
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  return {
    objects: backups.slice(0, MAX_LISTED_OBJECTS).map((object) => ({
      key: object.key,
      sizeBytes: object.size,
      lastModified: object.lastModified,
    })),
    complete,
  };
}

function parseRestoreBody(body: unknown, row: BackupDestinationRow): { key: string; passphrase: string | undefined } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ApiValidationError("Request body must be a JSON object");
  const record = body as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (field !== "key" && field !== "passphrase") throw new ApiValidationError(`Unknown field "${field}"`);
  }
  if (typeof record.key !== "string" || !isBackupKey(row, record.key)) {
    throw new ApiValidationError("key must name a backup file under the destination's prefix (see GET .../objects)");
  }
  let passphrase: string | undefined;
  if (record.passphrase !== undefined && record.passphrase !== null && record.passphrase !== "") {
    if (typeof record.passphrase !== "string" || record.passphrase.length > 1024) {
      throw new ApiValidationError("passphrase must be a string of at most 1024 characters");
    }
    passphrase = record.passphrase;
  }
  return { key: record.key, passphrase };
}

/**
 * Downloads a backup and imports it through the configuration import, which
 * validates it, checks the passphrase (the destination's, unless one is
 * given) and, when configuration history is on, saves the configuration it
 * replaces. Refused on a sync slave.
 */
export async function restoreBackup(
  destinationId: number,
  body: unknown,
  actorUserId: number,
  deps: BackupDependencies = {}
): Promise<BackupRestoreResult> {
  const row = await requireDestinationRow(destinationId);
  const input = parseRestoreBody(body, row);
  await assertConfigurationEditable();
  const passphrase = input.passphrase ?? storedPassphrase(row);
  const client = clientFor(row, { fetch: deps.fetch, now: deps.now });
  const { body: file, metadata } = await client.getObject(input.key, MAX_IMPORT_BYTES);
  const expected = metadata.sha256?.trim().toLowerCase();
  if (expected && /^[0-9a-f]{64}$/.test(expected) && sha256Hex(file) !== expected) {
    throw new S3Error("The downloaded file does not match the SHA-256 checksum stored with it; nothing was changed");
  }

  const saved = { snapshotId: null as number | null };
  try {
    const result = await importConfiguration({
      file: file.toString("utf8"),
      passphrase,
      userId: actorUserId,
      beforeWrite: beforeImportSnapshotHook(actorUserId, saved),
    });
    await logAuditEvent({
      userId: actorUserId,
      action: "config_backup_restored",
      entityType: "backup_destination",
      entityId: destinationId,
      summary: `Restored the configuration from backup ${input.key} of "${row.name}"`,
      data: { key: input.key, counts: result.counts, beforeSnapshotId: saved.snapshotId, warning: result.warning },
    });
    return { key: input.key, counts: result.counts, warning: result.warning, beforeSnapshotId: saved.snapshotId };
  } catch (error) {
    if (error instanceof ConfigurationApplyError) {
      await logAuditEvent({
        userId: actorUserId,
        action: "config_backup_restore_failed",
        entityType: "backup_destination",
        entityId: destinationId,
        summary: `Restoring backup ${input.key} of "${row.name}" failed; the previous configuration was kept`,
        data: { key: input.key },
      });
    }
    throw error;
  }
}

export async function listBackupRuns(options: { page: number; perPage: number; destinationId?: number }): Promise<BackupRunsPage> {
  const where = options.destinationId !== undefined ? eq(backupRuns.destinationId, options.destinationId) : undefined;
  const [{ value: total }] = await appDb.select({ value: count() }).from(backupRuns).where(where);
  const rows = await appDb
    .select({ run: backupRuns, destinationName: backupDestinations.name })
    .from(backupRuns)
    .leftJoin(backupDestinations, eq(backupDestinations.id, backupRuns.destinationId))
    .where(where)
    .orderBy(desc(backupRuns.id))
    .limit(options.perPage)
    .offset((options.page - 1) * options.perPage);
  return {
    runs: rows.map(({ run, destinationName }) => toRunView(run, destinationName ?? null)),
    total,
    page: options.page,
    perPage: options.perPage,
  };
}
