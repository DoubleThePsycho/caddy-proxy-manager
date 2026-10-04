// SPDX-License-Identifier: Elastic-2.0
/**
 * Fleet revisions: the configurations promotion-only environments are pinned
 * to.
 *
 * Configuration history snapshots do not fit: recording can be off, and
 * retention deletes old snapshots, also one an environment still runs. So a
 * promotion captures the master's configuration as a revision of its own,
 * reusing the newest revision with the same fingerprint. Revisions use the
 * snapshot format (src/lib/config-content.ts) and config-history's
 * fingerprint and diff, limited to what instance sync sends: the synced
 * tables and settings groups, without attribution and CA signing keys.
 * Secrets stay encrypted with this instance's key; nothing here returns
 * them (diffs only say that a secret changed).
 */
import { count, eq, inArray, isNotNull, lt, ne } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { fleetEnvironments, fleetInstances, fleetRevisions, fleetRollouts, fleetRolloutTargets, users } from "@/src/lib/db/schema";
import { ApiClientError, ApiConflictError, ApiValidationError } from "@/src/lib/api-errors";
import {
  CONFIG_TABLES,
  ConfigContentError,
  emptyConfigContent,
  readConfigContent,
  readCurrentConfigContent,
  type ConfigContent,
  type ConfigTableName,
  type DbTransaction,
} from "@/src/lib/config-content";
import { canonicalJson, configFingerprint } from "@/ee/config-history/fingerprint";
import { describeConfigContent, diffConfigContent, summarizeDiff, type ConfigDiff } from "@/ee/config-history/diff";
import { parseSnapshotContent } from "@/ee/config-history/snapshots";
import type { RevisionView } from "./types";
import { desc, first } from "@/src/lib/db/ops";
import { parseRowId } from "@/src/lib/row-ids";

export const REVISION_NOT_FOUND = "Revision not found";

/** Revisions kept besides those an environment, an instance or a kept rollout refers to. */
export const KEPT_REVISIONS = 100;
/** Finished rollouts kept; older ones are deleted with their targets. */
export const KEPT_FINISHED_ROLLOUTS = 500;

/** The configuration tables instance sync sends; the others stay on the master. */
const SYNCED_TABLES: readonly ConfigTableName[] = [
  "certificates",
  "caCertificates",
  "issuedClientCertificates",
  "accessLists",
  "accessListEntries",
  "accessListRules",
  "proxyHosts",
  "l4ProxyHosts",
  "wafRuleExclusions",
];

const MAX_SUMMARY_LENGTH = 1000;

/**
 * The part of a configuration that reaches slaves: the synced tables and the
 * settings groups, without attribution (the payload clears it) and without CA
 * signing keys (never synced).
 */
export function toFleetContent(content: ConfigContent): ConfigContent {
  const fleet = emptyConfigContent();
  for (const name of SYNCED_TABLES) {
    const attribution = CONFIG_TABLES[name].attributionColumns;
    fleet.tables[name] = content.tables[name].map((row) => {
      const copy = { ...row };
      for (const column of attribution) copy[column] = null;
      if (name === "caCertificates") copy.privateKeyPem = null;
      return copy;
    });
  }
  fleet.settings = { ...content.settings };
  return fleet;
}

/** The master's current configuration, as a revision would hold it. */
export async function currentFleetContent(): Promise<ConfigContent> {
  return toFleetContent(await readCurrentConfigContent());
}

const viewColumns = {
  id: fleetRevisions.id,
  createdAt: fleetRevisions.createdAt,
  createdBy: fleetRevisions.createdBy,
  userName: users.name,
  userEmail: users.email,
  summary: fleetRevisions.summary,
  fingerprint: fleetRevisions.fingerprint,
  sizeBytes: fleetRevisions.sizeBytes,
};

type ViewRow = {
  id: number;
  createdAt: string;
  createdBy: number | null;
  userName: string | null;
  userEmail: string | null;
  summary: string;
  fingerprint: string;
  sizeBytes: number;
};

function toView(row: ViewRow): RevisionView {
  return {
    id: row.id,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    createdByName: row.userName || row.userEmail || null,
    summary: row.summary,
    fingerprint: row.fingerprint,
    sizeBytes: row.sizeBytes,
  };
}

export async function listRevisions(options: { limit?: number; offset?: number } = {}): Promise<{ revisions: RevisionView[]; total: number }> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
  const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
  const rows = await appDb
    .select(viewColumns)
    .from(fleetRevisions)
    .leftJoin(users, eq(users.id, fleetRevisions.createdBy))
    .orderBy(desc(fleetRevisions.id))
    .limit(limit)
    .offset(offset);
  const [total] = await appDb.select({ value: count() }).from(fleetRevisions);
  return { revisions: rows.map(toView), total: total?.value ?? 0 };
}

export async function getRevision(id: number): Promise<RevisionView | null> {
  const [row] = await appDb
    .select(viewColumns)
    .from(fleetRevisions)
    .leftJoin(users, eq(users.id, fleetRevisions.createdBy))
    .where(eq(fleetRevisions.id, id))
    .limit(1);
  return row ? toView(row) : null;
}

export async function requireRevision(id: number): Promise<RevisionView> {
  const revision = await getRevision(id);
  if (!revision) throw new ApiClientError(REVISION_NOT_FOUND, 404);
  return revision;
}

/**
 * The content of revision `id`: null when it no longer exists, a 409 when
 * this release cannot read it (a schema change it does not know).
 */
export async function getRevisionContent(id: number): Promise<ConfigContent | null> {
  const [row] = await appDb.select({ content: fleetRevisions.content }).from(fleetRevisions).where(eq(fleetRevisions.id, id)).limit(1);
  if (!row) return null;
  try {
    return parseSnapshotContent(row.content);
  } catch (error) {
    if (error instanceof ConfigContentError) {
      throw new ApiConflictError(`Revision #${id} cannot be read by this release: ${error.message}`);
    }
    throw error;
  }
}

function truncate(text: string): string {
  return text.length > MAX_SUMMARY_LENGTH ? `${text.slice(0, MAX_SUMMARY_LENGTH - 1)}…` : text;
}

async function summarizeAgainstNewest(tx: DbTransaction, content: ConfigContent): Promise<string> {
  const newest = await first(tx.select({ content: fleetRevisions.content }).from(fleetRevisions).orderBy(desc(fleetRevisions.id)).limit(1));
  if (newest) {
    try {
      return summarizeDiff(diffConfigContent(parseSnapshotContent(newest.content), content));
    } catch {
      // The newest revision predates a schema change; describe the content instead.
    }
  }
  return `Initial revision: ${describeConfigContent(content)}`;
}

/**
 * Store the master's current configuration as a revision, in one
 * transaction, or return the newest revision with the same fingerprint.
 */
export async function captureCurrentRevision(userId: number | null): Promise<{ revision: RevisionView; created: boolean }> {
  const result = await appDb.transaction(async (tx) => {
    const content = toFleetContent(await readConfigContent(tx));
    const fingerprint = configFingerprint(content);
    const existing = await first(tx
      .select({ id: fleetRevisions.id })
      .from(fleetRevisions)
      .where(eq(fleetRevisions.fingerprint, fingerprint))
      .orderBy(desc(fleetRevisions.id))
      .limit(1));
    if (existing) return { id: existing.id, created: false };
    const serialized = canonicalJson(content);
    const row = (await first(tx
      .insert(fleetRevisions)
      .values({
        createdAt: nowIso(),
        createdBy: userId,
        summary: truncate(await summarizeAgainstNewest(tx, content)),
        fingerprint,
        content: serialized,
        sizeBytes: Buffer.byteLength(serialized, "utf8"),
      })
      .returning({ id: fleetRevisions.id })))!;
    return { id: row.id, created: true };
  });
  return { revision: (await getRevision(result.id))!, created: result.created };
}

export type RevisionDiffAgainst =
  | { kind: "current" }
  | { kind: "revision"; id: number }
  /** No earlier revision is kept; the diff is against an empty configuration. */
  | { kind: "empty" };

export type RevisionDiff = {
  revision: RevisionView;
  against: RevisionDiffAgainst;
  /** Changes that turn `against` into the revision. */
  diff: ConfigDiff;
};

async function requireRevisionContent(id: number): Promise<ConfigContent> {
  const content = await getRevisionContent(id);
  if (!content) throw new ApiClientError(REVISION_NOT_FOUND, 404);
  return content;
}

/** Differences from `against` ("current", "previous" or a revision id) to revision `id`. */
export async function getRevisionDiff(id: number, againstParam: string | null): Promise<RevisionDiff> {
  const revision = await requireRevision(id);
  const target = await requireRevisionContent(id);
  const param = (againstParam ?? "previous").trim() || "previous";
  let against: RevisionDiffAgainst;
  let base: ConfigContent;
  if (param === "current") {
    against = { kind: "current" };
    base = await currentFleetContent();
  } else if (param === "previous") {
    const [previous] = await appDb
      .select({ id: fleetRevisions.id })
      .from(fleetRevisions)
      .where(lt(fleetRevisions.id, id))
      .orderBy(desc(fleetRevisions.id))
      .limit(1);
    const previousId = previous?.id ?? null;
    if (previousId === null) {
      against = { kind: "empty" };
      base = emptyConfigContent();
    } else {
      against = { kind: "revision", id: previousId };
      base = await requireRevisionContent(previousId);
    }
  } else if (parseRowId(param) !== null) {
    const otherId = parseRowId(param)!;
    if (!(await getRevision(otherId))) throw new ApiClientError("Revision to compare with not found", 404);
    against = { kind: "revision", id: otherId };
    base = await requireRevisionContent(otherId);
  } else {
    throw new ApiValidationError('against must be "current", "previous" or a revision id');
  }
  return { revision, against, diff: diffConfigContent(base, target) };
}

/**
 * Delete old revisions and finished rollouts: the newest KEPT_REVISIONS
 * revisions stay, and so does every revision an environment is pinned to,
 * an instance last received or a kept rollout names.
 */
export async function pruneFleetHistory(): Promise<void> {
  const finished = await appDb
    .select({ id: fleetRollouts.id })
    .from(fleetRollouts)
    .where(ne(fleetRollouts.status, "running"))
    .orderBy(desc(fleetRollouts.id));
  const dropped = finished.slice(KEPT_FINISHED_ROLLOUTS).map((row) => row.id);
  if (dropped.length > 0) {
    await appDb.delete(fleetRolloutTargets).where(inArray(fleetRolloutTargets.rolloutId, dropped));
    await appDb.delete(fleetRollouts).where(inArray(fleetRollouts.id, dropped));
  }

  const referenced = new Set<number>();
  for (const row of await appDb.select({ id: fleetEnvironments.revisionId }).from(fleetEnvironments).where(isNotNull(fleetEnvironments.revisionId))) {
    referenced.add(row.id!);
  }
  for (const row of await appDb.select({ id: fleetInstances.revisionId }).from(fleetInstances).where(isNotNull(fleetInstances.revisionId))) {
    referenced.add(row.id!);
  }
  for (const row of await appDb
    .select({ revisionId: fleetRollouts.revisionId, fromRevisionId: fleetRollouts.fromRevisionId })
    .from(fleetRollouts)) {
    referenced.add(row.revisionId);
    if (row.fromRevisionId !== null) referenced.add(row.fromRevisionId);
  }
  const all = await appDb.select({ id: fleetRevisions.id }).from(fleetRevisions).orderBy(desc(fleetRevisions.id));
  const stale = all.slice(KEPT_REVISIONS).map((row) => row.id).filter((id) => !referenced.has(id));
  if (stale.length > 0) await appDb.delete(fleetRevisions).where(inArray(fleetRevisions.id, stale));
}
