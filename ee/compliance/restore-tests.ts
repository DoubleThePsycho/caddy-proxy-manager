// SPDX-License-Identifier: Elastic-2.0
/**
 * Test restores of configuration backups, recorded by a person as evidence
 * that backups can be restored (business continuity controls). The test
 * itself happens elsewhere, usually on a spare instance; this is the record.
 */
import { count, eq, inArray } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { backupDestinations, complianceRestoreTests, users } from "@/src/lib/db/schema";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import { parseInstant, parseLine, parseMultiline, rejectUnknownKeys, requireRecord } from "./http";
import { desc, first } from "@/src/lib/db/ops";

export const RESTORE_TEST_NOT_FOUND = "Restore test not found";
export const RESTORE_SOURCES = ["backup", "snapshot", "export", "other"] as const;
export type RestoreSource = (typeof RESTORE_SOURCES)[number];
export const RESTORE_OUTCOMES = ["success", "partial", "failed"] as const;
export type RestoreOutcome = (typeof RESTORE_OUTCOMES)[number];
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_NOTES = 2000;

export type RestoreTestView = {
  id: number;
  testedAt: string;
  source: RestoreSource;
  backupDestination: { id: number; name: string | null } | null;
  backupObjectKey: string | null;
  outcome: RestoreOutcome;
  notes: string | null;
  recordedBy: { userId: number | null; name: string | null };
  createdAt: string;
};

type Row = typeof complianceRestoreTests.$inferSelect;

function toView(row: Row, destinations: Map<number, string>): RestoreTestView {
  return {
    id: row.id,
    testedAt: row.testedAt,
    source: (RESTORE_SOURCES as readonly string[]).includes(row.source) ? (row.source as RestoreSource) : "other",
    backupDestination: row.backupDestinationId !== null ? { id: row.backupDestinationId, name: destinations.get(row.backupDestinationId) ?? null } : null,
    backupObjectKey: row.backupObjectKey,
    outcome: (RESTORE_OUTCOMES as readonly string[]).includes(row.outcome) ? (row.outcome as RestoreOutcome) : "failed",
    notes: row.notes,
    recordedBy: { userId: row.recordedBy, name: row.recordedByName },
    createdAt: row.createdAt,
  };
}

async function destinationNames(ids: number[]): Promise<Map<number, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  return new Map((await appDb.select({ id: backupDestinations.id, name: backupDestinations.name }).from(backupDestinations).where(inArray(backupDestinations.id, unique))).map((row) => [row.id, row.name]));
}

export async function listRestoreTests(options: { page: number; perPage: number }): Promise<{ tests: RestoreTestView[]; total: number; page: number; perPage: number }> {
  const rows = await appDb
    .select()
    .from(complianceRestoreTests)
    .orderBy(desc(complianceRestoreTests.testedAt), desc(complianceRestoreTests.id))
    .limit(options.perPage)
    .offset((options.page - 1) * options.perPage);
  const total = (await first(appDb.select({ value: count() }).from(complianceRestoreTests).limit(1)))?.value ?? 0;
  const names = await destinationNames(rows.map((row) => row.backupDestinationId).filter((id): id is number => id !== null));
  return { tests: rows.map((row) => toView(row, names)), total, page: options.page, perPage: options.perPage };
}

/** The newest successful test restore, if any. */
export async function latestSuccessfulRestoreTest(): Promise<RestoreTestView | null> {
  const row = await first(appDb
    .select()
    .from(complianceRestoreTests)
    .where(eq(complianceRestoreTests.outcome, "success"))
    .orderBy(desc(complianceRestoreTests.testedAt), desc(complianceRestoreTests.id))
    .limit(1));
  if (!row) return null;
  return toView(row, await destinationNames(row.backupDestinationId !== null ? [row.backupDestinationId] : []));
}

/** {testedAt, source, outcome, backupDestinationId?, backupObjectKey?, notes?}. */
export async function recordRestoreTest(body: unknown, actorUserId: number, now: Date = new Date()): Promise<RestoreTestView> {
  const record = requireRecord(body);
  rejectUnknownKeys(record, ["testedAt", "source", "outcome", "backupDestinationId", "backupObjectKey", "notes"], "the restore test");
  const testedAt = parseInstant(record.testedAt, "testedAt");
  if (testedAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) throw new ApiValidationError("testedAt must not be in the future");
  if (!(RESTORE_SOURCES as readonly unknown[]).includes(record.source)) throw new ApiValidationError(`source must be one of: ${RESTORE_SOURCES.join(", ")}`);
  if (!(RESTORE_OUTCOMES as readonly unknown[]).includes(record.outcome)) throw new ApiValidationError(`outcome must be one of: ${RESTORE_OUTCOMES.join(", ")}`);
  let destinationId: number | null = null;
  if (record.backupDestinationId !== undefined && record.backupDestinationId !== null) {
    if (typeof record.backupDestinationId !== "number" || !Number.isSafeInteger(record.backupDestinationId) || record.backupDestinationId < 1) {
      throw new ApiValidationError("backupDestinationId must be a backup destination id");
    }
    if (!await first(appDb.select({ id: backupDestinations.id }).from(backupDestinations).where(eq(backupDestinations.id, record.backupDestinationId)).limit(1))) {
      throw new ApiValidationError("backupDestinationId does not name a backup destination");
    }
    destinationId = record.backupDestinationId;
  }
  const objectKey = record.backupObjectKey === undefined || record.backupObjectKey === null || record.backupObjectKey === ""
    ? null
    : parseLine(record.backupObjectKey, "backupObjectKey", 512);
  const notes = record.notes === undefined || record.notes === null ? null : parseMultiline(record.notes, "notes", MAX_NOTES) || null;
  const user = await first(appDb.select({ name: users.name, email: users.email, username: users.username }).from(users).where(eq(users.id, actorUserId)).limit(1));
  const row = (await first(appDb
    .insert(complianceRestoreTests)
    .values({
      testedAt: testedAt.toISOString(),
      source: record.source as RestoreSource,
      backupDestinationId: destinationId,
      backupObjectKey: objectKey,
      outcome: record.outcome as RestoreOutcome,
      notes,
      recordedBy: actorUserId,
      recordedByName: user ? user.name ?? user.username ?? user.email : null,
      createdAt: nowIso(),
    })
    .returning()))!;
  await logAuditEvent({
    userId: actorUserId,
    action: "compliance_restore_test_recorded",
    entityType: "compliance_restore_test",
    entityId: row.id,
    summary: `Recorded a ${row.outcome === "success" ? "successful" : row.outcome === "partial" ? "partly successful" : "failed"} test restore from ${row.testedAt.slice(0, 10)}`,
    data: { testedAt: row.testedAt, source: row.source, outcome: row.outcome, backupDestinationId: destinationId, backupObjectKey: objectKey },
  });
  return toView(row, await destinationNames(destinationId !== null ? [destinationId] : []));
}

export async function deleteRestoreTest(id: number, actorUserId: number): Promise<void> {
  const row = await first(appDb.select().from(complianceRestoreTests).where(eq(complianceRestoreTests.id, id)).limit(1));
  if (!row) throw new ApiClientError(RESTORE_TEST_NOT_FOUND, 404);
  await appDb.delete(complianceRestoreTests).where(eq(complianceRestoreTests.id, id));
  await logAuditEvent({
    userId: actorUserId,
    action: "compliance_restore_test_deleted",
    entityType: "compliance_restore_test",
    entityId: id,
    summary: `Deleted the record of the test restore from ${row.testedAt.slice(0, 10)}`,
    data: { testedAt: row.testedAt, outcome: row.outcome },
  });
}
