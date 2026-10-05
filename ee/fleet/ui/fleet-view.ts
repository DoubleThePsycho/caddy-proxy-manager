// SPDX-License-Identifier: Elastic-2.0
/**
 * What the Fleet page derives from the fleet overview: times, versions,
 * node health and the state of a node against its environment and the
 * running rollout. Pure functions, shared by the page's components.
 */
import type { StatusTone } from "@/components/ui/StatusDot";
import {
  DRIFT_STATUS_LABELS,
  type CertificateStorageSummary,
  type EnvironmentView,
  type FleetInstanceView,
  type FleetOverview,
  type PullReplicaView,
  type RolloutPhase,
  type RolloutView,
} from "@/ee/fleet/types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** "11:35" in UTC. */
export function formatClock(value: string | number): string {
  const date = new Date(value);
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/**
 * A UTC time as the page shows it: "11:35:20" today, "2 Oct 16:05" earlier
 * this year, "2 Oct 2025" before. `now` keeps server and browser renders equal.
 */
export function formatWhen(value: string | number, now: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date(now);
  const sameDay =
    date.getUTCFullYear() === today.getUTCFullYear() &&
    date.getUTCMonth() === today.getUTCMonth() &&
    date.getUTCDate() === today.getUTCDate();
  if (sameDay) return `${formatClock(value)}:${pad(date.getUTCSeconds())}`;
  const day = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
  if (date.getUTCFullYear() === today.getUTCFullYear()) return `${day} ${formatClock(value)}`;
  return `${day} ${date.getUTCFullYear()}`;
}

/** "45 s", "10 min", "9 min 20 s", "2 h 5 min". */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours} h` : `${hours} h ${restMinutes} min`;
}

/** "a, b and c". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** "#47", or "none". */
export function revisionLabel(id: number | null): string {
  return id === null ? "none" : `#${id}`;
}

function versionParts(version: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** -1 when `version` is older than `reference`, 1 when newer, 0 when equal, null when either cannot be compared. */
export function compareVersions(version: string, reference: string): -1 | 0 | 1 | null {
  const a = versionParts(version);
  const b = versionParts(reference);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

/** "v2.0.3" for a release, the text as it is otherwise. */
export function formatVersion(version: string): string {
  return versionParts(version) && !version.startsWith("v") ? `v${version}` : version;
}

export const PHASE_LABELS: Record<RolloutPhase, string> = {
  canary: "Syncing the canary",
  observing: "Observing the canary",
  rolling: "Rolling out",
  done: "Done",
};

/** The version a node last reported: from its drift check, or a pull replica's last report. */
export function reportedVersion(instance: FleetInstanceView, replica: PullReplicaView | undefined): string | null {
  return instance.drift.reportedVersion ?? replica?.reportedVersion ?? null;
}

export type Health = { tone: StatusTone; label: string; note: string | null; title?: string };

/**
 * How a node is doing, from what the master knows: a pull replica's
 * check-ins and reports, a push replica's last drift check and sync.
 */
export function nodeHealth(instance: FleetInstanceView, replica: PullReplicaView | undefined, now: number): Health {
  if (!instance.enabled) return { tone: "off", label: "Disabled", note: null };
  if (instance.pull) {
    if (instance.pull.checkIn === "never") return { tone: "off", label: "Never checked in", note: null };
    if (instance.pull.checkIn === "missed") {
      return {
        tone: "bad",
        label: "Not checking in",
        note: instance.pull.lastSeenAt ? `last check-in ${formatWhen(instance.pull.lastSeenAt, now)}` : null,
      };
    }
    if (replica?.caddy && !replica.caddy.ok) {
      return { tone: "bad", label: "Caddy apply failed", note: replica.caddy.code ?? null };
    }
    if (instance.lastSyncError) return { tone: "warn", label: "Last sync failed", note: null };
    return { tone: "ok", label: "Healthy", note: null };
  }
  if (instance.drift.status === "unreachable") {
    return { tone: "bad", label: "Unreachable", note: instance.drift.checkedAt ? `checked ${formatClock(instance.drift.checkedAt)}` : null, title: instance.drift.detail ?? undefined };
  }
  if (instance.lastSyncError) return { tone: "warn", label: "Last sync failed", note: null };
  if (!instance.drift.checkedAt) return { tone: "off", label: "Unknown", note: "not checked yet" };
  return { tone: "ok", label: "Healthy", note: `checked ${formatClock(instance.drift.checkedAt)}` };
}

export type DriftDisplay = { tone: StatusTone; label: string; note: string | null; title?: string; attention: boolean };

export function nodeDrift(instance: FleetInstanceView, now: number): DriftDisplay {
  const status = instance.drift.status;
  if (!instance.enabled) return { tone: "off", label: "Disabled", note: null, attention: false };
  if (!status) return { tone: "off", label: "Not checked", note: null, attention: false };
  const title = instance.drift.detail ?? undefined;
  switch (status) {
    case "in_sync":
      return { tone: "ok", label: DRIFT_STATUS_LABELS.in_sync, note: instance.drift.localChanges === null && title ? "local changes unknown" : null, title, attention: false };
    case "drifted":
      return {
        tone: "warn",
        label: DRIFT_STATUS_LABELS.drifted,
        note: instance.drift.since ? `since ${formatWhen(instance.drift.since, now)}` : null,
        title,
        attention: true,
      };
    case "unreachable":
      return { tone: "bad", label: DRIFT_STATUS_LABELS.unreachable, note: null, title, attention: false };
    case "older_version":
      return { tone: "off", label: DRIFT_STATUS_LABELS.older_version, note: "cannot report", title, attention: false };
    default:
      return { tone: "off", label: DRIFT_STATUS_LABELS.unknown, note: null, title, attention: false };
  }
}

/** A node's part in the rollout running in its environment, if any. */
export function rolloutTarget(rollout: RolloutView | null, instanceId: number) {
  return rollout?.targets.find((target) => target.instanceId === instanceId) ?? null;
}

export type ConfigurationDisplay = { label: string; revisionId: number | null; note: string | null; tone: "warn" | "brand" | null };

/** What a node runs, and how that compares with its environment and the rollout running there. */
export function nodeConfiguration(instance: FleetInstanceView, environment: EnvironmentView | null, rollout: RolloutView | null): ConfigurationDisplay {
  const label = instance.revisionId !== null ? "Revision" : instance.pushedAt ? "Live configuration" : "Nothing pushed yet";
  const target = rolloutTarget(rollout, instance.id);
  if (rollout && target) {
    if (target.status === "synced" && instance.revisionId === rollout.revisionId) {
      return { label, revisionId: instance.revisionId, note: `ahead of ${environment?.name ?? "its environment"}`, tone: "brand" };
    }
    if (target.status === "pending") {
      const when = target.role === "canary" || rollout.phase === "rolling" ? "now" : "after the canary";
      return { label, revisionId: instance.revisionId, note: `takes #${rollout.revisionId} ${when}`, tone: "brand" };
    }
  }
  if (environment?.promotionOnly && environment.revisionId !== null && instance.revisionId !== environment.revisionId) {
    return { label, revisionId: instance.revisionId, note: "Behind its environment", tone: "warn" };
  }
  if (!environment?.promotionOnly && instance.revisionId === null && instance.pushedAt) {
    return { label, revisionId: null, note: "every change", tone: null };
  }
  return { label, revisionId: instance.revisionId, note: null, tone: null };
}

/** Whether a node runs something else than its environment is pinned to (and no rollout is taking care of it). */
export function isBehind(instance: FleetInstanceView, environment: EnvironmentView | null, rollout: RolloutView | null): boolean {
  if (!instance.enabled || !environment?.promotionOnly || environment.revisionId === null) return false;
  if (rolloutTarget(rollout, instance.id)) return false;
  return instance.revisionId !== environment.revisionId;
}

/** The certificate storage a node uses as far as the master knows: what its last configuration set. */
export function nodeStorage(instance: FleetInstanceView, overview: FleetOverview): CertificateStorageSummary | null {
  if (instance.revisionId !== null) return overview.revisionStorage[String(instance.revisionId)] ?? null;
  if (instance.pushedAt) return overview.master.certificateStorage;
  return null;
}

const REDIS_MODE_LABELS: Record<NonNullable<CertificateStorageSummary["redisMode"]>, string> = {
  standalone: "Redis",
  cluster: "Redis Cluster",
  sentinel: "Redis Sentinel",
};

/** "Shared" with "Redis Sentinel", or "Local" with "on the node". */
export function storageLabel(storage: CertificateStorageSummary): { label: string; note: string } {
  if (storage.backend === "redis") return { label: "Shared", note: storage.redisMode ? REDIS_MODE_LABELS[storage.redisMode] : "Redis" };
  return { label: "Local", note: "on the node" };
}

export function sameStorage(a: CertificateStorageSummary | null, b: CertificateStorageSummary | null): boolean {
  return !a || !b || (a.backend === b.backend && a.redisMode === b.redisMode);
}

/** The latest drift check of any node. */
export function lastDriftCheck(instances: readonly FleetInstanceView[]): string | null {
  let latest: string | null = null;
  for (const instance of instances) {
    const at = instance.drift.checkedAt;
    if (at && (!latest || at > latest)) latest = at;
  }
  return latest;
}
