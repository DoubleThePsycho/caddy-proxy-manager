// SPDX-License-Identifier: Elastic-2.0
/**
 * Configuration history as versions: each snapshot with a readable title
 * (from the audit events that produced it, links.ts), who made it, how big
 * the change was, structured diffs between any two versions, and what
 * rolling back to a version would do.
 *
 * Read-only and never license-checked: viewing history keeps working when
 * the license lapses (restoring is gated in service.ts). Secrets are never
 * returned (diff.ts masks them).
 */
import { and, count, eq, gt, inArray, isNotNull, lt } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { auditEvents, configSnapshots, users } from "@/src/lib/db/schema";
import { NotFoundError } from "@/src/lib/api-auth";
import { ApiConflictError, ApiValidationError } from "@/src/lib/api-errors";
import { getInstanceMode } from "@/src/lib/instance-sync";
import {
  CONFIG_SETTING_KEYS,
  CONFIG_SETTING_LABELS,
  CONFIG_TABLE_NAMES,
  CONFIG_TABLES,
  ConfigContentError,
  emptyConfigContent,
  readCurrentConfigContent,
  type ConfigContent,
  type ConfigRow,
  type ConfigSettingKey,
  type ConfigTableName,
} from "@/src/lib/config-content";
import { can, type Access } from "@/src/lib/permissions";
import { isFeatureConfigurable } from "@/ee/licensing/store";
import { protectedReplacementChanges } from "@/ee/approvals/guard";
import { TARGET_LABELS } from "@/ee/approvals/types";
import { getConfigurationReach } from "@/ee/fleet/reach";
import { configFingerprint } from "./fingerprint";
import { rowFieldChanges, rowLabel, settingFieldChanges, type FieldChange } from "./diff";
import { configEntityOf, describeChangeSize, itemMatchesEntity, parseVersionChanges, type ChangeEntity, type VersionChanges } from "./changes";
import { computeVersionChanges } from "./summarize";
import { getHistorySettings } from "./settings";
import { getSnapshot, parseSnapshotContent, SNAPSHOT_REASONS, type SnapshotReason, type SnapshotView } from "./snapshots";
import { desc } from "@/src/lib/db/ops";
import { parseRowId } from "@/src/lib/row-ids";

export const FEATURE = "config_history" as const;

export type VersionActor = { userId: number; name: string | null };

export type VersionView = SnapshotView & {
  /** What the version is about, in words. */
  title: string;
  /** audit: from the audit events that produced it; note: the manual note; summary: computed from the diff. */
  titleSource: "audit" | "note" | "summary";
  /** Who made the changes (from the audit events; the snapshot's user otherwise). */
  actors: VersionActor[];
  /** Audit events recorded for the changes in this version. */
  auditEventIds: number[];
  /** Change requests (ee/approvals) whose approved changes are in this version. */
  changeRequestIds: number[];
  previousId: number | null;
  /** e.g. "1 host · 2 fields"; "First version"; "No changes". */
  size: string;
  totals: VersionChanges["totals"] | null;
  /** Hosts and settings groups it touched (at most 20 of each). */
  touched: { hosts: { type: "proxy_host" | "l4_proxy_host"; id: number; label: string }[]; settings: string[] };
  /** The configuration running now is this version. */
  live: boolean;
};

const MAX_TOUCHED = 20;

function readReason(value: string): SnapshotReason {
  return (SNAPSHOT_REASONS as readonly string[]).includes(value) ? (value as SnapshotReason) : "auto";
}

// ── Stored changes ────────────────────────────────────────────────────

/**
 * The changes of each version, computing (and storing) the ones recorded
 * before they were kept: against the newest version kept before it.
 */
async function ensureChanges(rows: { id: number; previousId: number | null; changes: string | null }[]): Promise<Map<number, VersionChanges | null>> {
  const result = new Map<number, VersionChanges | null>();
  for (const row of rows) {
    const stored = parseVersionChanges(row.changes);
    if (stored) {
      result.set(row.id, stored);
      continue;
    }
    try {
      const [current] = await appDb.select({ content: configSnapshots.content }).from(configSnapshots).where(eq(configSnapshots.id, row.id)).limit(1);
      const [previous] = await appDb
        .select({ id: configSnapshots.id, content: configSnapshots.content })
        .from(configSnapshots)
        .where(lt(configSnapshots.id, row.id))
        .orderBy(desc(configSnapshots.id))
        .limit(1);
      if (!current) {
        result.set(row.id, null);
        continue;
      }
      const { changes } = computeVersionChanges(previous ? parseSnapshotContent(previous.content) : null, parseSnapshotContent(current.content), previous?.id ?? null);
      // Versions never change, so the result can be kept.
      await appDb.update(configSnapshots).set({ changes: JSON.stringify(changes), previousId: changes.previousId }).where(eq(configSnapshots.id, row.id));
      result.set(row.id, changes);
    } catch (error) {
      if (!(error instanceof ConfigContentError)) throw error;
      // A version this release cannot read has no change summary.
      result.set(row.id, null);
    }
  }
  return result;
}

// ── Titles from the audit log ─────────────────────────────────────────

type LinkedEvent = { id: number; afterId: number; userId: number | null; summary: string | null; action: string; changeRequestId: number | null };

async function linkedEvents(ids: number[]): Promise<Map<number, LinkedEvent[]>> {
  const map = new Map<number, LinkedEvent[]>();
  if (ids.length === 0) return map;
  const rows = await appDb
    .select({
      id: auditEvents.id,
      afterId: auditEvents.configAfterId,
      beforeId: auditEvents.configBeforeId,
      userId: auditEvents.userId,
      summary: auditEvents.summary,
      action: auditEvents.action,
      changeRequestId: auditEvents.changeRequestId,
    })
    .from(auditEvents)
    .where(and(inArray(auditEvents.configAfterId, ids), isNotNull(auditEvents.configBeforeId)))
    .orderBy(auditEvents.id);
  for (const row of rows) {
    // after == before: the event changed nothing (closed by an apply without changes).
    if (row.afterId === null || row.afterId === row.beforeId) continue;
    const list = map.get(row.afterId) ?? [];
    list.push({ id: row.id, afterId: row.afterId, userId: row.userId, summary: row.summary, action: row.action, changeRequestId: row.changeRequestId });
    map.set(row.afterId, list);
  }
  return map;
}

async function userNames(ids: number[]): Promise<Map<number, string | null>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await appDb.select({ id: users.id, name: users.name, email: users.email, username: users.username }).from(users).where(inArray(users.id, unique));
  return new Map(rows.map((row) => [row.id, row.name?.trim() || row.username || row.email]));
}

/** Change requests apply through the model functions, which record their own events: those name the change. */
const BOOKKEEPING_ACTIONS = new Set(["change_request_applied"]);

function titleOf(snapshot: SnapshotView, events: LinkedEvent[]): { title: string; source: VersionView["titleSource"] } {
  if (snapshot.reason === "manual") return { title: snapshot.summary, source: "note" };
  if (snapshot.reason !== "auto") return { title: snapshot.summary, source: "summary" };
  const named = events.filter((event) => event.summary && !BOOKKEEPING_ACTIONS.has(event.action));
  if (named.length === 0) return { title: snapshot.summary, source: "summary" };
  const first = named[0].summary!.replace(/\p{Cc}+/gu, " ").slice(0, 300);
  const more = named.length - 1;
  return { title: more > 0 ? `${first} and ${more} more change${more === 1 ? "" : "s"}` : first, source: "audit" };
}

function touchedOf(changes: VersionChanges | null): VersionView["touched"] {
  const hosts = new Map<string, VersionView["touched"]["hosts"][number]>();
  const settingKeys = new Set<string>();
  for (const item of changes?.items ?? []) {
    if (item.entity === "settings") settingKeys.add(String(item.id));
    if (item.host) {
      const key = `${item.host.type}:${item.host.id}`;
      const label = (item.entity === "proxyHosts" || item.entity === "l4ProxyHosts") ? item.label : hosts.get(key)?.label ?? `#${item.host.id}`;
      hosts.set(key, { ...item.host, label });
    }
  }
  return { hosts: [...hosts.values()].slice(0, MAX_TOUCHED), settings: [...settingKeys].slice(0, MAX_TOUCHED) };
}

/** The newest version, if the configuration running now is exactly it. */
async function liveVersionId(): Promise<number | null> {
  const [newest] = await appDb
    .select({ id: configSnapshots.id, fingerprint: configSnapshots.fingerprint })
    .from(configSnapshots)
    .orderBy(desc(configSnapshots.id))
    .limit(1);
  if (!newest) return null;
  return configFingerprint(await readCurrentConfigContent()) === newest.fingerprint ? newest.id : null;
}

type SnapshotRow = {
  id: number;
  createdAt: string;
  userId: number | null;
  reason: string;
  summary: string;
  fingerprint: string;
  sizeBytes: number;
  previousId: number | null;
  changes: string | null;
};

async function toVersionViews(rows: SnapshotRow[], liveId: number | null): Promise<VersionView[]> {
  const changes = await ensureChanges(rows);
  const events = await linkedEvents(rows.map((row) => row.id));
  const names = await userNames([
    ...rows.map((row) => row.userId).filter((id): id is number => id !== null),
    ...[...events.values()].flat().map((event) => event.userId).filter((id): id is number => id !== null),
  ]);
  return rows.map((row) => {
    const snapshot: SnapshotView = {
      id: row.id,
      createdAt: row.createdAt,
      userId: row.userId,
      userName: row.userId !== null ? names.get(row.userId) ?? null : null,
      reason: readReason(row.reason),
      summary: row.summary,
      fingerprint: row.fingerprint,
      sizeBytes: row.sizeBytes,
    };
    const linked = events.get(row.id) ?? [];
    const title = titleOf(snapshot, linked);
    const actorIds = [...new Set(linked.map((event) => event.userId).filter((id): id is number => id !== null))];
    const actors = actorIds.length > 0
      ? actorIds.map((userId) => ({ userId, name: names.get(userId) ?? null }))
      : row.userId !== null ? [{ userId: row.userId, name: names.get(row.userId) ?? null }] : [];
    const versionChanges = changes.get(row.id) ?? null;
    return {
      ...snapshot,
      title: title.title,
      titleSource: title.source,
      actors,
      auditEventIds: linked.map((event) => event.id),
      changeRequestIds: [...new Set(linked.map((event) => event.changeRequestId).filter((id): id is number => id !== null))],
      previousId: versionChanges?.previousId ?? null,
      size: versionChanges ? describeChangeSize(versionChanges) : "Unknown",
      totals: versionChanges?.totals ?? null,
      touched: touchedOf(versionChanges),
      live: liveId === row.id,
    };
  });
}

const ROW_COLUMNS = {
  id: configSnapshots.id,
  createdAt: configSnapshots.createdAt,
  userId: configSnapshots.userId,
  reason: configSnapshots.reason,
  summary: configSnapshots.summary,
  fingerprint: configSnapshots.fingerprint,
  sizeBytes: configSnapshots.sizeBytes,
  previousId: configSnapshots.previousId,
  changes: configSnapshots.changes,
};

export type VersionList = {
  versions: VersionView[];
  total: number;
  limit: number;
  offset: number;
  /** The version running now; null when the running configuration has changes no version holds. */
  liveId: number | null;
  recording: { enabled: boolean; retention: number };
};

/** Versions, newest first. */
export async function listVersions(options: { limit?: number; offset?: number } = {}): Promise<VersionList> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
  const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
  const rows = await appDb.select(ROW_COLUMNS).from(configSnapshots).orderBy(desc(configSnapshots.id)).limit(limit).offset(offset);
  const [total] = await appDb.select({ value: count() }).from(configSnapshots);
  const liveId = await liveVersionId();
  const settings = await getHistorySettings();
  return { versions: await toVersionViews(rows, liveId), total: total?.value ?? 0, limit, offset, liveId, recording: settings };
}

export async function getVersion(id: number): Promise<VersionView> {
  const [row] = await appDb.select(ROW_COLUMNS).from(configSnapshots).where(eq(configSnapshots.id, id)).limit(1);
  if (!row) throw new NotFoundError("Snapshot not found");
  return (await toVersionViews([row], await liveVersionId()))[0];
}

// ── Comparing two versions ────────────────────────────────────────────

export type CompareField = FieldChange & {
  /** For a reference (accessListId, certificateId): the name it pointed to. */
  beforeLabel?: string | null;
  afterLabel?: string | null;
};

export type CompareGroup = {
  entity: ChangeEntity;
  entityLabel: string;
  id: number | string;
  label: string;
  kind: "added" | "removed" | "changed";
  /** The host the row belongs to (an mTLS rule or forward-auth grant names its proxy host). */
  host: { type: "proxy_host" | "l4_proxy_host"; id: number; label: string } | null;
  fields: CompareField[];
};

export type CompareSide = { kind: "current" } | { kind: "snapshot"; id: number } | { kind: "empty" };

export type VersionComparison = {
  from: CompareSide;
  to: CompareSide;
  totals: { added: number; removed: number; changed: number; fields: number };
  groups: CompareGroup[];
};

/** References whose ids mean nothing to a reader: shown with the name they point to. */
const REFERENCES: Partial<Record<ConfigTableName, Record<string, ConfigTableName>>> = {
  proxyHosts: { accessListId: "accessLists", certificateId: "certificates" },
  issuedClientCertificates: { caCertificateId: "caCertificates" },
  accessListEntries: { accessListId: "accessLists" },
  mtlsAccessRules: { proxyHostId: "proxyHosts" },
  forwardAuthAccess: { proxyHostId: "proxyHosts", groupId: "groups" },
};

function nameIn(content: ConfigContent, table: ConfigTableName, id: unknown): string | null {
  if (typeof id !== "number") return null;
  const row = content.tables[table].find((candidate) => candidate.id === id);
  return row ? rowLabel(table, row) : `#${id} (no longer exists)`;
}

function hostLabel(content: ConfigContent, other: ConfigContent, type: "proxy_host" | "l4_proxy_host", id: number): string {
  const table = type === "proxy_host" ? "proxyHosts" : "l4ProxyHosts";
  const row = content.tables[table].find((candidate) => candidate.id === id) ?? other.tables[table].find((candidate) => candidate.id === id);
  return row ? rowLabel(table, row) : `#${id}`;
}

function rowHost(table: ConfigTableName, row: ConfigRow): { type: "proxy_host" | "l4_proxy_host"; id: number } | null {
  if (table === "proxyHosts") return { type: "proxy_host", id: row.id as number };
  if (table === "l4ProxyHosts") return { type: "l4_proxy_host", id: row.id as number };
  if ((table === "mtlsAccessRules" || table === "forwardAuthAccess") && typeof row.proxyHostId === "number") {
    return { type: "proxy_host", id: row.proxyHostId };
  }
  return null;
}

/** Every difference from `from` to `to`, per row and settings group, field by field. */
export function compareContents(from: ConfigContent, to: ConfigContent): Omit<VersionComparison, "from" | "to"> {
  const groups: CompareGroup[] = [];
  const totals = { added: 0, removed: 0, changed: 0, fields: 0 };
  for (const table of CONFIG_TABLE_NAMES) {
    const before = new Map(from.tables[table].map((row) => [row.id as number, row]));
    const after = new Map(to.tables[table].map((row) => [row.id as number, row]));
    const references = REFERENCES[table] ?? {};
    for (const id of [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a - b)) {
      const a = before.get(id) ?? null;
      const b = after.get(id) ?? null;
      const fields: CompareField[] = rowFieldChanges(table, a, b).map((change) => {
        const target = references[change.path];
        if (!target || change.secret) return change;
        return { ...change, beforeLabel: nameIn(from, target, change.before), afterLabel: nameIn(to, target, change.after) };
      });
      if (a && b && fields.length === 0) continue;
      const kind = !a ? "added" : !b ? "removed" : "changed";
      totals[kind] += 1;
      if (kind === "changed") totals.fields += fields.length;
      const row = (b ?? a)!;
      const host = rowHost(table, row);
      groups.push({
        entity: table,
        entityLabel: CONFIG_TABLES[table].plural,
        id,
        label: rowLabel(table, row),
        kind,
        host: host ? { ...host, label: hostLabel(to, from, host.type, host.id) } : null,
        fields,
      });
    }
  }
  for (const key of CONFIG_SETTING_KEYS) {
    const a = from.settings[key] ?? null;
    const b = to.settings[key] ?? null;
    if (a === null && b === null) continue;
    const fields = settingFieldChanges(key, a, b);
    if (a !== null && b !== null && fields.length === 0) continue;
    const kind = a === null ? "added" : b === null ? "removed" : "changed";
    totals[kind] += 1;
    if (kind === "changed") totals.fields += fields.length;
    groups.push({ entity: "settings", entityLabel: "Settings", id: key, label: CONFIG_SETTING_LABELS[key as ConfigSettingKey], kind, host: null, fields });
  }
  return { totals, groups };
}

async function loadContent(id: number): Promise<ConfigContent> {
  const [row] = await appDb.select({ content: configSnapshots.content }).from(configSnapshots).where(eq(configSnapshots.id, id)).limit(1);
  if (!row) throw new NotFoundError("Snapshot not found");
  try {
    return parseSnapshotContent(row.content);
  } catch (error) {
    if (error instanceof ConfigContentError) throw new ApiConflictError(`Snapshot #${id} cannot be read by this release: ${error.message}`);
    throw error;
  }
}

async function resolveSide(param: string, relativeTo: number | null): Promise<{ side: CompareSide; content: ConfigContent }> {
  if (param === "current") return { side: { kind: "current" }, content: await readCurrentConfigContent() };
  if (param === "previous") {
    if (relativeTo === null) throw new ApiValidationError('"previous" needs a version id on the other side');
    const [previous] = await appDb.select({ id: configSnapshots.id }).from(configSnapshots).where(lt(configSnapshots.id, relativeTo)).orderBy(desc(configSnapshots.id)).limit(1);
    if (!previous) return { side: { kind: "empty" }, content: emptyConfigContent() };
    return { side: { kind: "snapshot", id: previous.id }, content: await loadContent(previous.id) };
  }
  const id = parseRowId(param);
  if (id !== null) return { side: { kind: "snapshot", id }, content: await loadContent(id) };
  throw new ApiValidationError('from and to must be "current", "previous" (from only) or a version id');
}

/** Differences going from version `fromParam` to version `toParam` ("current", "previous" or an id). */
export async function compareVersions(fromParam: string | null, toParam: string | null): Promise<VersionComparison> {
  const toRaw = (toParam ?? "current").trim() || "current";
  if (toRaw === "previous") throw new ApiValidationError('to must be "current" or a version id');
  const to = await resolveSide(toRaw, null);
  const fromRaw = (fromParam ?? "previous").trim() || "previous";
  const from = await resolveSide(fromRaw, to.side.kind === "snapshot" ? to.side.id : null);
  return { from: from.side, to: to.side, ...compareContents(from.content, to.content) };
}

// ── Rollback preview ──────────────────────────────────────────────────

export type RollbackHost = {
  type: "proxy_host" | "l4_proxy_host";
  id: number;
  name: string;
  /** From the live configuration's point of view: added back, removed (it did not exist yet), or changed. */
  kind: "added" | "removed" | "changed";
  fields: string[];
};

export type RollbackPreview = {
  target: VersionView;
  /** The version running now; null when the running configuration holds changes no version has. */
  liveId: number | null;
  /** Rolling back would change nothing. */
  identical: boolean;
  hosts: RollbackHost[];
  settings: { key: string; label: string; kind: "added" | "removed" | "changed"; fields: string[] }[];
  /** Other rows that change (access lists, certificates, groups, ...). */
  other: { entity: ChangeEntity; entityLabel: string; id: number | string; label: string; kind: "added" | "removed" | "changed" }[];
  /** Later versions whose changes the rollback undoes, newest first. */
  undoes: Pick<VersionView, "id" | "title" | "createdAt" | "actors" | "reason" | "changeRequestIds">[];
  /** The running configuration has changes no version holds (history was off, or an apply failed); they are undone too. */
  undoesUnrecordedChanges: boolean;
  /** Later versions that changed a host this version itself changed. */
  sameHostWarnings: { versionId: number; title: string; createdAt: string; actors: VersionActor[]; hosts: string[] }[];
  /** Approval policies that protect hosts the rollback changes: it would be refused with 409. */
  blocked: { message: string; hosts: { type: "proxy_host" | "l4_proxy_host"; id: number; name: string; operations: string[]; policies: { id: number; name: string }[] }[] } | null;
  /** Caddy nodes that reload the configuration. */
  reload: { nodes: number; instances: string[]; heldBack: string[] };
  /** Whether the caller can roll back now, and why not. */
  canRestore: boolean;
  reasons: string[];
};

const MAX_UNDONE = 200;

/** What rolling back to version `id` would do (nothing is changed). */
export async function previewRollback(id: number, access?: Access): Promise<RollbackPreview> {
  const snapshot = await getSnapshot(id);
  if (!snapshot) throw new NotFoundError("Snapshot not found");
  const targetContent = await loadContent(id);
  const current = await readCurrentConfigContent();
  const liveId = await liveVersionId();
  const [target] = await toVersionViews(
    await appDb.select(ROW_COLUMNS).from(configSnapshots).where(eq(configSnapshots.id, id)).limit(1),
    liveId
  );
  const comparison = compareContents(current, targetContent);

  const hosts = new Map<string, RollbackHost>();
  const settingsChanged: RollbackPreview["settings"] = [];
  const other: RollbackPreview["other"] = [];
  for (const group of comparison.groups) {
    if (group.entity === "settings") {
      settingsChanged.push({ key: String(group.id), label: group.label, kind: group.kind, fields: group.fields.map((field) => field.path) });
      continue;
    }
    if (!group.host) {
      other.push({ entity: group.entity, entityLabel: group.entityLabel, id: group.id, label: group.label, kind: group.kind });
      continue;
    }
    const key = `${group.host.type}:${group.host.id}`;
    const isHostRow = group.entity === "proxyHosts" || group.entity === "l4ProxyHosts";
    const entry = hosts.get(key) ?? { type: group.host.type, id: group.host.id, name: group.host.label, kind: "changed" as const, fields: [] };
    if (isHostRow) entry.kind = group.kind;
    entry.fields.push(...(isHostRow ? group.fields.map((field) => field.path) : [`${CONFIG_TABLES[group.entity as ConfigTableName].singular} ${group.label}`]));
    hosts.set(key, entry);
  }

  // Later versions: everything after the target is undone.
  const laterRows = await appDb.select(ROW_COLUMNS).from(configSnapshots).where(gt(configSnapshots.id, id)).orderBy(desc(configSnapshots.id)).limit(MAX_UNDONE);
  const later = await toVersionViews(laterRows, liveId);
  const undoes = later
    .filter((version) => (version.totals?.items ?? 0) > 0)
    .map((version) => ({ id: version.id, title: version.title, createdAt: version.createdAt, actors: version.actors, reason: version.reason, changeRequestIds: version.changeRequestIds }));

  const ownHosts = new Map(target.touched.hosts.map((host) => [`${host.type}:${host.id}`, host.label]));
  const sameHostWarnings = later
    .map((version) => ({
      versionId: version.id,
      title: version.title,
      createdAt: version.createdAt,
      actors: version.actors,
      hosts: version.touched.hosts.filter((host) => ownHosts.has(`${host.type}:${host.id}`)).map((host) => host.label),
    }))
    .filter((warning) => warning.hosts.length > 0);

  const protectedChanges = await protectedReplacementChanges(appDb, current, targetContent);
  const blocked = protectedChanges.length === 0
    ? null
    : {
        message:
          "Approval policies protect hosts this rollback changes, so it would be refused. An administrator can turn the policies off, " +
          "roll back and turn them on again; every step is recorded in the audit log.",
        hosts: protectedChanges.map((change) => ({
          type: change.targetType,
          id: change.id,
          name: change.name,
          operations: change.operations,
          policies: change.policies.map((policy) => ({ id: policy.id, name: policy.name })),
        })),
      };

  const reach = await getConfigurationReach();
  const reasons: string[] = [];
  if ((await getInstanceMode()) === "slave") reasons.push("This instance is a sync slave: its configuration comes from the master.");
  if (!(await isFeatureConfigurable(FEATURE))) reasons.push("Rolling back needs a license that includes configuration history.");
  if (access && !can(access, "config_history:restore")) reasons.push("Rolling back needs the config_history:restore permission.");
  if (blocked) reasons.push(`Protected by an approval policy: ${blocked.hosts.map((host) => `${TARGET_LABELS[host.type].toLowerCase()} "${host.name}"`).slice(0, 5).join(", ")}.`);
  const identical = comparison.groups.length === 0;
  if (identical) reasons.push("This version matches the running configuration: rolling back would change nothing.");

  return {
    target,
    liveId,
    identical,
    hosts: [...hosts.values()],
    settings: settingsChanged,
    other,
    undoes,
    undoesUnrecordedChanges: liveId === null && !identical,
    sameHostWarnings,
    blocked,
    reload: { nodes: reach.nodes, instances: reach.instances.map((instance) => instance.name), heldBack: reach.heldBack.map((instance) => instance.name) },
    canRestore: reasons.length === 0,
    reasons,
  };
}

// ── Audit log diffs ───────────────────────────────────────────────────

export type AuditChangeDiff = {
  beforeId: number;
  afterId: number;
  /** Whether both versions are still kept (retention deletes old ones). */
  available: boolean;
  reason: string | null;
  /** The event's own entity only (a proxy host with its mTLS rules and grants); everything for whole-configuration events. */
  groups: CompareGroup[];
  filtered: boolean;
  /** More groups changed than are listed. */
  truncated: boolean;
};

const MAX_AUDIT_GROUPS = 100;

/**
 * The before/after diff of a configuration change recorded in the audit log,
 * from the versions stored with the event; null for an event without them
 * (not a configuration change, recorded while history was off or before the
 * link existed, or still waiting for its version).
 */
export async function auditEventConfigDiff(event: {
  action: string;
  entityType: string;
  entityId: number | null;
  configBeforeId: number | null;
  configAfterId: number | null;
}): Promise<AuditChangeDiff | null> {
  const { configBeforeId: beforeId, configAfterId: afterId } = event;
  if (beforeId === null || afterId === null) return null;
  const base = { beforeId, afterId, filtered: true, truncated: false };
  if (beforeId === afterId) return { ...base, available: true, reason: "The change left the configuration as it was.", groups: [] };
  const rows = await appDb.select({ id: configSnapshots.id }).from(configSnapshots).where(inArray(configSnapshots.id, [beforeId, afterId]));
  if (rows.length < 2) {
    return { ...base, available: false, reason: "The configuration history no longer keeps these versions.", groups: [] };
  }
  let before: ConfigContent;
  let after: ConfigContent;
  try {
    [before, after] = await Promise.all([loadContent(beforeId), loadContent(afterId)]);
  } catch (error) {
    if (error instanceof ApiConflictError) return { ...base, available: false, reason: error.message, groups: [] };
    throw error;
  }
  const entity = configEntityOf(event);
  const all = compareContents(before, after).groups;
  const groups = entity ? all.filter((group) => itemMatchesEntity({ entity: group.entity, id: group.id, host: group.host }, entity)) : all;
  return {
    ...base,
    available: true,
    reason: null,
    filtered: entity !== null && entity.kind !== "all",
    groups: groups.slice(0, MAX_AUDIT_GROUPS),
    truncated: groups.length > MAX_AUDIT_GROUPS,
  };
}
