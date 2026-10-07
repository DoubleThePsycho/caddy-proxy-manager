// SPDX-License-Identifier: Elastic-2.0
/**
 * Configuration snapshots: storage, retention and automatic recording. The
 * operations an administrator starts are in service.ts.
 */
import { count, eq, lt } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { configSnapshots, users } from "@/src/lib/db/schema";
import { getInstanceMode } from "@/src/lib/instance-sync";
import {
  ConfigContentError,
  parseConfigContent,
  readConfigContent,
  type ConfigContent,
  type DbTransaction,
} from "@/src/lib/config-content";
import { canonicalJson, configFingerprint } from "./fingerprint";
import { describeConfigContent, summarizeDiff } from "./diff";
import { readHistorySettingsInTx } from "./settings";
import { computeVersionChanges } from "./summarize";
import { closePendingEventsInTx, linkPendingEventsInTx } from "./links";
import type { VersionChanges } from "./changes";
import { SNAPSHOT_REASONS, type SnapshotReason } from "./reasons";
import { desc, first } from "@/src/lib/db/ops";

export { SNAPSHOT_REASONS, SNAPSHOT_REASON_LABELS, type SnapshotReason } from "./reasons";

const MAX_SUMMARY_LENGTH = 1000;

/** A snapshot without its content. */
export type SnapshotView = {
  id: number;
  createdAt: string;
  userId: number | null;
  /** Name or email of the user, null for automatic snapshots or a deleted user. */
  userName: string | null;
  reason: SnapshotReason;
  summary: string;
  fingerprint: string;
  sizeBytes: number;
};

const viewColumns = {
  id: configSnapshots.id,
  createdAt: configSnapshots.createdAt,
  userId: configSnapshots.userId,
  userName: users.name,
  userEmail: users.email,
  reason: configSnapshots.reason,
  summary: configSnapshots.summary,
  fingerprint: configSnapshots.fingerprint,
  sizeBytes: configSnapshots.sizeBytes,
};

type ViewRow = {
  id: number;
  createdAt: string;
  userId: number | null;
  userName: string | null;
  userEmail: string | null;
  reason: string;
  summary: string;
  fingerprint: string;
  sizeBytes: number;
};

function toView(row: ViewRow): SnapshotView {
  return {
    id: row.id,
    createdAt: row.createdAt,
    userId: row.userId,
    userName: row.userName || row.userEmail || null,
    reason: (SNAPSHOT_REASONS as readonly string[]).includes(row.reason) ? (row.reason as SnapshotReason) : "auto",
    summary: row.summary,
    fingerprint: row.fingerprint,
    sizeBytes: row.sizeBytes,
  };
}

export async function listSnapshots(options: { limit?: number; offset?: number } = {}): Promise<{ snapshots: SnapshotView[]; total: number }> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 500);
  const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
  const rows = await appDb
    .select(viewColumns)
    .from(configSnapshots)
    .leftJoin(users, eq(users.id, configSnapshots.userId))
    .orderBy(desc(configSnapshots.id))
    .limit(limit)
    .offset(offset);
  const [total] = await appDb.select({ value: count() }).from(configSnapshots);
  return { snapshots: rows.map(toView), total: total?.value ?? 0 };
}

export async function getSnapshot(id: number): Promise<SnapshotView | null> {
  const [row] = await appDb
    .select(viewColumns)
    .from(configSnapshots)
    .leftJoin(users, eq(users.id, configSnapshots.userId))
    .where(eq(configSnapshots.id, id))
    .limit(1);
  return row ? toView(row) : null;
}

/** The snapshot taken just before `id`, if it is still kept. */
export async function getPreviousSnapshotId(id: number): Promise<number | null> {
  const [row] = await appDb
    .select({ id: configSnapshots.id })
    .from(configSnapshots)
    .where(lt(configSnapshots.id, id))
    .orderBy(desc(configSnapshots.id))
    .limit(1);
  return row?.id ?? null;
}

/** Parses stored snapshot content; ConfigContentError when it no longer fits the schema. */
export function parseSnapshotContent(serialized: string): ConfigContent {
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    throw new ConfigContentError("the stored content is not JSON");
  }
  return parseConfigContent(raw);
}

/** The content of snapshot `id`, or null when there is no such snapshot. */
export async function getSnapshotContent(id: number): Promise<ConfigContent | null> {
  const [row] = await appDb
    .select({ content: configSnapshots.content })
    .from(configSnapshots)
    .where(eq(configSnapshots.id, id))
    .limit(1);
  return row ? parseSnapshotContent(row.content) : null;
}

/** Deletes all but the newest `retention` snapshots. */
export async function pruneSnapshotsInTx(tx: DbTransaction, retention: number): Promise<void> {
  const kept = await tx
    .select({ id: configSnapshots.id })
    .from(configSnapshots)
    .orderBy(desc(configSnapshots.id))
    .limit(retention);
  if (kept.length < retention) return;
  const oldestKept = kept[kept.length - 1].id;
  await tx.delete(configSnapshots).where(lt(configSnapshots.id, oldestKept));
}

export type SnapshotInput = {
  content: ConfigContent;
  reason: SnapshotReason;
  userId: number | null;
  summary: string;
  retention: number;
  fingerprint?: string;
  /** What changed from the version before (computed lazily when left out). */
  previousId?: number | null;
  changes?: VersionChanges | null;
};

/**
 * Stores a snapshot (rows as stored: secrets stay encrypted), links the
 * audit events waiting for it (links.ts) and applies retention.
 */
export async function insertSnapshotInTx(tx: DbTransaction, input: SnapshotInput): Promise<SnapshotView> {
  const content = canonicalJson(input.content);
  const summary = input.summary.length > MAX_SUMMARY_LENGTH ? `${input.summary.slice(0, MAX_SUMMARY_LENGTH - 1)}…` : input.summary;
  const row = (await first(tx
    .insert(configSnapshots)
    .values({
      createdAt: nowIso(),
      userId: input.userId,
      reason: input.reason,
      summary,
      fingerprint: input.fingerprint ?? configFingerprint(input.content),
      content,
      sizeBytes: Buffer.byteLength(content, "utf8"),
      previousId: input.changes ? input.previousId ?? null : null,
      changes: input.changes ? JSON.stringify(input.changes) : null,
    })
    .returning()))!;
  await linkPendingEventsInTx(tx, row.id);
  await pruneSnapshotsInTx(tx, input.retention);
  return toView({ ...row, userName: null, userEmail: null });
}

/**
 * How `content` differs from the newest snapshot: a one-line summary and
 * the structured changes (or a description of the whole content).
 */
async function summarizeAgainstLatest(tx: DbTransaction, content: ConfigContent): Promise<{ summary: string; previousId: number | null; changes: VersionChanges | null }> {
  const latest = await first(tx
    .select({ id: configSnapshots.id, content: configSnapshots.content })
    .from(configSnapshots)
    .orderBy(desc(configSnapshots.id))
    .limit(1));
  if (latest) {
    try {
      const { changes, diff } = computeVersionChanges(parseSnapshotContent(latest.content), content, latest.id);
      return { summary: diff ? summarizeDiff(diff) : "No changes", previousId: latest.id, changes };
    } catch {
      // The newest snapshot predates a schema change; describe the content instead.
    }
  }
  return {
    summary: `Initial snapshot: ${describeConfigContent(content)}`,
    previousId: null,
    changes: latest ? null : computeVersionChanges(null, content, null).changes,
  };
}

/**
 * Stores the current configuration unless it equals the newest snapshot
 * (same fingerprint). Returns the new snapshot, or null when unchanged.
 */
export async function recordIfChangedInTx(
  tx: DbTransaction,
  input: { reason: SnapshotReason; userId: number | null; retention: number; summary?: string }
): Promise<SnapshotView | null> {
  const content = await readConfigContent(tx);
  const fingerprint = configFingerprint(content);
  const latest = await first(tx
    .select({ fingerprint: configSnapshots.fingerprint })
    .from(configSnapshots)
    .orderBy(desc(configSnapshots.id))
    .limit(1));
  if (latest?.fingerprint === fingerprint) return null;
  const computed = await summarizeAgainstLatest(tx, content);
  return await insertSnapshotInTx(tx, {
    content,
    fingerprint,
    reason: input.reason,
    userId: input.userId,
    summary: input.summary ?? computed.summary,
    retention: input.retention,
    previousId: computed.previousId,
    changes: computed.changes,
  });
}

/**
 * Called by applyCaddyConfig after Caddy accepted a configuration: records
 * it when history is enabled and it differs from the newest snapshot. Sync
 * slaves record nothing (their configuration comes from the master). Never
 * throws: history must not get in the way of applying a configuration.
 */
export async function recordConfigSnapshotAfterApply(): Promise<void> {
  try {
    if ((await getInstanceMode()) === "slave") return;
    await appDb.transaction(async (tx) => {
      const settings = await readHistorySettingsInTx(tx);
      if (!settings.enabled) return;
      const recorded = await recordIfChangedInTx(tx, { reason: "auto", userId: null, retention: settings.retention });
      if (!recorded) {
        // Nothing changed: audit events waiting for this apply changed nothing either.
        const latest = await first(tx.select({ id: configSnapshots.id }).from(configSnapshots).orderBy(desc(configSnapshots.id)).limit(1));
        if (latest) await closePendingEventsInTx(tx, latest.id);
      }
    });
  } catch (error) {
    console.warn(
      "Configuration history: could not record a snapshot:",
      error instanceof Error ? error.name : typeof error
    );
  }
}

/**
 * A beforeWrite hook for importConfiguration: when history is enabled, saves
 * the configuration about to be replaced (reason "import") in the import's
 * transaction. Records the snapshot id in `saved`.
 */
export function beforeImportSnapshotHook(userId: number, saved: { snapshotId: number | null } = { snapshotId: null }) {
  return async (tx: DbTransaction, current: ConfigContent): Promise<void> => {
    const settings = await readHistorySettingsInTx(tx);
    if (!settings.enabled) return;
    saved.snapshotId = (await insertSnapshotInTx(tx, {
      content: current,
      reason: "import",
      userId,
      summary: "Configuration before an import",
      retention: settings.retention,
    })).id;
  };
}
