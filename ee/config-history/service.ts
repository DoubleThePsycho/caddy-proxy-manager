// SPDX-License-Identifier: Elastic-2.0
/** Configuration history operations for administrators. */
import { count, eq } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { configSnapshots } from "@/src/lib/db/schema";
import { NotFoundError } from "@/src/lib/api-auth";
import { ApiConflictError, ApiValidationError } from "@/src/lib/api-errors";
import { logAuditEvent } from "@/src/lib/audit";
import { setSetting } from "@/src/lib/settings";
import {
  ConfigContentError,
  emptyConfigContent,
  readConfigContent,
  readCurrentConfigContent,
  type ConfigContent,
} from "@/src/lib/config-content";
import {
  assertConfigurationEditable,
  ConfigurationApplyError,
  replaceConfiguration,
} from "@/src/lib/config-replace";
import {
  describeConfigContent,
  diffConfigContent,
  summarizeConfigContent,
  type ConfigDiff,
  type ContentSummary,
} from "./diff";
import {
  getHistorySettings,
  HISTORY_SETTING_KEY,
  parseHistorySettingsUpdate,
  readHistorySettingsInTx,
  type HistorySettings,
} from "./settings";
import { dropPendingEventsInTx } from "./links";
import {
  getPreviousSnapshotId,
  getSnapshot,
  getSnapshotContent,
  insertSnapshotInTx,
  parseSnapshotContent,
  pruneSnapshotsInTx,
  recordIfChangedInTx,
  type SnapshotView,
} from "./snapshots";
import { parseRowId } from "@/src/lib/row-ids";

const MAX_MANUAL_SUMMARY_LENGTH = 200;

/** Parses a positive integer id from a route parameter; 404 otherwise. */
export function parseSnapshotId(raw: string): number {
  const id = parseRowId(raw);
  if (id === null) throw new NotFoundError("Snapshot not found");
  return id;
}

/** Saves the current configuration as a manual snapshot (also when it equals the newest one). */
export async function createManualSnapshot(userId: number, input: unknown = {}): Promise<SnapshotView> {
  await assertConfigurationEditable();
  let note: string | null = null;
  if (input !== undefined && input !== null) {
    if (typeof input !== "object" || Array.isArray(input)) throw new ApiValidationError("Body must be an object");
    for (const key of Object.keys(input)) {
      if (key !== "summary") throw new ApiValidationError(`Unknown field "${key}"`);
    }
    const summary = (input as { summary?: unknown }).summary;
    if (summary !== undefined && summary !== null) {
      if (typeof summary !== "string" || summary.trim().length > MAX_MANUAL_SUMMARY_LENGTH) {
        throw new ApiValidationError(`summary must be a string of at most ${MAX_MANUAL_SUMMARY_LENGTH} characters`);
      }
      note = summary.trim() || null;
    }
  }

  const snapshot = await appDb.transaction(async (tx) => {
    const settings = await readHistorySettingsInTx(tx);
    const content = await readConfigContent(tx);
    return await insertSnapshotInTx(tx, {
      content,
      reason: "manual",
      userId,
      summary: note ?? `Manual snapshot: ${describeConfigContent(content)}`,
      retention: settings.retention,
    });
  });
  await logAuditEvent({
    userId,
    action: "config_snapshot_created",
    entityType: "config_snapshot",
    entityId: snapshot.id,
    summary: `Created configuration snapshot #${snapshot.id}`,
  });
  return (await getSnapshot(snapshot.id)) ?? snapshot;
}

/**
 * Changes the history settings. Enabling records a first snapshot right
 * away; lowering the retention deletes the snapshots beyond it.
 */
export async function updateHistorySettings(input: unknown, userId: number): Promise<HistorySettings> {
  const current = await getHistorySettings();
  const next = parseHistorySettingsUpdate(input, current);
  await setSetting(HISTORY_SETTING_KEY, next);

  await appDb.transaction(async (tx) => {
    if (next.retention < current.retention) await pruneSnapshotsInTx(tx, next.retention);
    if (next.enabled && !current.enabled) {
      await recordIfChangedInTx(tx, { reason: "auto", userId, retention: next.retention });
    }
    // Events still waiting for a version would otherwise be matched with one recorded much later.
    if (!next.enabled && current.enabled) await dropPendingEventsInTx(tx);
  });

  const changes: string[] = [];
  if (next.enabled !== current.enabled) changes.push(next.enabled ? "enabled recording" : "disabled recording");
  if (next.retention !== current.retention) changes.push(`retention ${current.retention} → ${next.retention}`);
  await logAuditEvent({
    userId,
    action: "config_history_settings_updated",
    entityType: "config_history",
    summary: `Configuration history: ${changes.length > 0 ? changes.join(", ") : "settings saved without changes"}`,
    data: { before: current, after: next },
  });
  return next;
}

/** Deletes one snapshot. */
export async function deleteSnapshot(id: number, userId: number): Promise<void> {
  const snapshot = await getSnapshot(id);
  if (!snapshot) throw new NotFoundError("Snapshot not found");
  await appDb.delete(configSnapshots).where(eq(configSnapshots.id, id));
  await logAuditEvent({
    userId,
    action: "config_snapshot_deleted",
    entityType: "config_snapshot",
    entityId: id,
    summary: `Deleted configuration snapshot #${id}`,
  });
}

/** Deletes every snapshot. Returns how many were deleted. */
export async function deleteAllSnapshots(userId: number): Promise<number> {
  const [row] = await appDb.select({ value: count() }).from(configSnapshots);
  const deleted = row?.value ?? 0;
  await appDb.delete(configSnapshots);
  await logAuditEvent({
    userId,
    action: "config_snapshots_deleted",
    entityType: "config_snapshot",
    summary: `Deleted all ${deleted} configuration snapshot(s)`,
  });
  return deleted;
}

export type SnapshotDetail = SnapshotView & { content: ContentSummary };

/** A snapshot with a summary of what it contains (names and counts, no values). */
export async function getSnapshotDetail(id: number): Promise<SnapshotDetail> {
  const snapshot = await getSnapshot(id);
  if (!snapshot) throw new NotFoundError("Snapshot not found");
  const content = await loadSnapshotContentForView(id);
  return { ...snapshot, content: summarizeConfigContent(content) };
}

async function loadSnapshotContentForView(id: number): Promise<ConfigContent> {
  let content: ConfigContent | null;
  try {
    content = await getSnapshotContent(id);
  } catch (error) {
    if (error instanceof ConfigContentError) {
      throw new ApiConflictError(`Snapshot #${id} cannot be read by this release: ${error.message}`);
    }
    throw error;
  }
  if (!content) throw new NotFoundError("Snapshot not found");
  return content;
}

export type DiffAgainst =
  | { kind: "current" }
  | { kind: "snapshot"; id: number }
  /** There is no earlier snapshot; the diff is against an empty configuration. */
  | { kind: "empty" };

export type SnapshotDiff = {
  snapshot: SnapshotView;
  against: DiffAgainst;
  /** Changes that turn `against` into the snapshot (what restoring it would do, for "current"). */
  diff: ConfigDiff;
};

/**
 * Differences from `against` ("current", "previous" or a snapshot id) to
 * snapshot `id`.
 */
export async function getSnapshotDiff(id: number, againstParam: string | null): Promise<SnapshotDiff> {
  const snapshot = await getSnapshot(id);
  if (!snapshot) throw new NotFoundError("Snapshot not found");
  const target = await loadSnapshotContentForView(id);

  const param = (againstParam ?? "current").trim() || "current";
  let against: DiffAgainst;
  let base: ConfigContent;
  if (param === "current") {
    against = { kind: "current" };
    base = await readCurrentConfigContent();
  } else if (param === "previous") {
    const previousId = await getPreviousSnapshotId(id);
    if (previousId === null) {
      against = { kind: "empty" };
      base = emptyConfigContent();
    } else {
      against = { kind: "snapshot", id: previousId };
      base = await loadSnapshotContentForView(previousId);
    }
  } else if (parseRowId(param) !== null) {
    const otherId = parseRowId(param)!;
    if (!(await getSnapshot(otherId))) throw new NotFoundError("Snapshot to compare with not found");
    against = { kind: "snapshot", id: otherId };
    base = await loadSnapshotContentForView(otherId);
  } else {
    throw new ApiValidationError('against must be "current", "previous" or a snapshot id');
  }
  return { snapshot, against, diff: diffConfigContent(base, target) };
}

export type RestoreResult = {
  restoredSnapshotId: number;
  /** The snapshot of the configuration as it was before the restore. */
  beforeSnapshotId: number;
  warning: string | null;
};

/**
 * Replaces the configuration with snapshot `id`. The configuration being
 * replaced is saved first (reason "before_restore") in the same transaction.
 * If Caddy rejects the result, the previous configuration is put back and a
 * ConfigurationApplyError is thrown. Refused on sync slaves.
 */
export async function restoreSnapshot(id: number, userId: number): Promise<RestoreResult> {
  await assertConfigurationEditable();

  const [row] = await appDb
    .select({ content: configSnapshots.content })
    .from(configSnapshots)
    .where(eq(configSnapshots.id, id))
    .limit(1);
  if (!row) throw new NotFoundError("Snapshot not found");
  let content: ConfigContent;
  try {
    content = parseSnapshotContent(row.content);
  } catch (error) {
    if (error instanceof ConfigContentError) {
      throw new ApiConflictError(`Snapshot #${id} cannot be restored by this release: ${error.message}`);
    }
    throw error;
  }

  const saved: { beforeSnapshotId: number | null } = { beforeSnapshotId: null };
  try {
    const { warning } = await replaceConfiguration(content, {
      mode: "restore",
      beforeWrite: async (tx, current) => {
        const settings = await readHistorySettingsInTx(tx);
        saved.beforeSnapshotId = (await insertSnapshotInTx(tx, {
          content: current,
          reason: "before_restore",
          userId,
          summary: `Configuration before restoring snapshot #${id}`,
          retention: settings.retention,
        })).id;
      },
    });
    await logAuditEvent({
      userId,
      action: "config_restored",
      entityType: "config_snapshot",
      entityId: id,
      summary: `Restored configuration snapshot #${id}`,
      data: { beforeSnapshotId: saved.beforeSnapshotId, warning },
    });
    return { restoredSnapshotId: id, beforeSnapshotId: saved.beforeSnapshotId!, warning };
  } catch (error) {
    if (error instanceof ConfigurationApplyError) {
      await logAuditEvent({
        userId,
        action: "config_restore_failed",
        entityType: "config_snapshot",
        entityId: id,
        summary: `Restoring configuration snapshot #${id} failed; the previous configuration was kept`,
      });
    }
    throw error;
  }
}
