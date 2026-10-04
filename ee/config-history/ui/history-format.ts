// SPDX-License-Identifier: Elastic-2.0
/**
 * Pure helpers of the Change history page: day groups for the version
 * timeline, labels for snapshot reasons, actors and comparisons, and the
 * wording of the rollback preview. Safe on the server and the client.
 */
import type { SnapshotReason } from "@/ee/config-history/reasons";
import type { CompareField, CompareGroup, RollbackPreview, VersionActor, VersionView } from "@/ee/config-history/versions";
import type { DiffField } from "@/components/ui/DiffView";
import { parseRowId } from "@/src/lib/row-ids";

/** Short pill on the timeline; automatic versions show none. */
export const REASON_SHORT: Record<SnapshotReason, string | null> = {
  auto: null,
  manual: "Manual",
  before_restore: "Before rollback",
  import: "Before import",
};

/** Pill in the version header. */
export const REASON_LONG: Record<SnapshotReason, string> = {
  auto: "Automatic",
  manual: "Manual, with a note",
  before_restore: "Saved before a rollback",
  import: "Saved before an import",
};

export type DotTone = "live" | "selected" | "warn" | "plain";

/** The colour of a version's dot on the timeline. */
export function versionDot(version: Pick<VersionView, "live" | "reason">, selected: boolean): DotTone {
  if (version.live) return "live";
  if (selected) return "selected";
  if (version.reason === "before_restore" || version.reason === "import") return "warn";
  return "plain";
}

/** "AD" for admin, "JM" for j.moretti, "AB" for Alice Brown. */
export function initials(name: string | null | undefined): string {
  if (!name) return "SY";
  const local = name.split("@")[0].trim();
  const parts = local.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return (parts[0] ?? local).slice(0, 2).toUpperCase() || "?";
}

function actorName(actor: VersionActor): string {
  return actor.name?.trim() || `User #${actor.userId}`;
}

/** Who made a version: "admin", "admin and l.bianchi", "admin and 2 others", "System". */
export function describeActors(actors: readonly VersionActor[]): string {
  if (actors.length === 0) return "System";
  if (actors.length === 1) return actorName(actors[0]);
  if (actors.length === 2) return `${actorName(actors[0])} and ${actorName(actors[1])}`;
  return `${actorName(actors[0])} and ${actors.length - 1} others`;
}

/** The first actor's name, for the avatar. */
export function leadActor(actors: readonly VersionActor[]): string | null {
  return actors.length > 0 ? actorName(actors[0]) : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

function dayLabel(ms: number, timeZone: string, withYear: boolean): string {
  const options: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) };
  try {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone }).format(new Date(ms)).replace(",", "");
  } catch {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" }).format(new Date(ms)).replace(",", "");
  }
}

export type DayGroup<T> = { key: string; label: string; items: T[] };

/**
 * Versions grouped by the day they were saved, in the account's time zone,
 * keeping their order: "Today, Sat 3 Oct", "Yesterday, Fri 2 Oct", "Thu 1 Oct";
 * days of another year carry the year.
 */
export function groupByDay<T extends { createdAt: string }>(items: readonly T[], now: number, timeZone: string): DayGroup<T>[] {
  const today = dayKey(now, timeZone);
  const yesterday = dayKey(now - DAY_MS, timeZone);
  const thisYear = today.slice(0, 4);
  const groups: DayGroup<T>[] = [];
  for (const item of items) {
    const ms = Date.parse(item.createdAt);
    const key = Number.isNaN(ms) ? "unknown" : dayKey(ms, timeZone);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      const plain = Number.isNaN(ms) ? "Unknown date" : dayLabel(ms, timeZone, key.slice(0, 4) !== thisYear);
      const label = key === today ? `Today, ${plain}` : key === yesterday ? `Yesterday, ${plain}` : plain;
      group = { key, label, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

// ── Comparing ─────────────────────────────────────────────────────────

/** What a version is compared with: the version before it, the running configuration, or another version. */
export type CompareTarget = "previous" | "live" | number;

export function parseCompareParam(value: string | null | undefined): CompareTarget {
  if (value === "live") return "live";
  return parseRowId(value) ?? "previous";
}

export function compareParam(target: CompareTarget): string {
  return typeof target === "number" ? String(target) : target;
}

/** The query of GET /api/v1/config-history/compare for version `id`. */
export function compareQuery(id: number, target: CompareTarget): string {
  const from = target === "live" ? "current" : target === "previous" ? "previous" : String(target);
  return `from=${encodeURIComponent(from)}&to=${id}`;
}

/** A compared field as DiffView shows it: references with the names they point to. */
export function toDiffField(field: CompareField): DiffField {
  const withName = (value: unknown, label: string | null | undefined) =>
    label && value !== null && value !== undefined ? `${label} (#${String(value)})` : value;
  return {
    path: field.path,
    before: withName(field.before, field.beforeLabel),
    after: withName(field.after, field.afterLabel),
    ...(field.secret ? { secret: true } : {}),
  };
}

export function groupTitle(group: Pick<CompareGroup, "entityLabel" | "label">): string {
  return `${group.entityLabel} › ${group.label}`;
}

/** Shown when a comparison finds no difference. */
export function emptyCompareText(
  version: Pick<VersionView, "id" | "reason" | "title">,
  target: CompareTarget,
  previousId: number | null
): string {
  if (target === "live") return `No differences: #${version.id} matches the live configuration.`;
  if (typeof target === "number") return `No differences between #${target} and #${version.id}.`;
  const from = previousId !== null ? `#${previousId}` : "the version before it";
  if (version.reason === "manual") {
    return `No differences from ${from}. A manual version saves the configuration as it was, with the note “${version.title}”.`;
  }
  if (version.reason === "before_restore") {
    return `No differences from ${from}. This is the configuration that was live before a rollback, kept so it can be restored.`;
  }
  if (version.reason === "import") {
    return `No differences from ${from}. This is the configuration an import replaced, kept so it can be restored.`;
  }
  return `No differences from ${from}.`;
}

// ── Rollback preview ──────────────────────────────────────────────────

/** "Added back", "Removed: it did not exist yet" or the fields that change. */
export function describeRollbackHost(host: RollbackPreview["hosts"][number]): string {
  if (host.kind === "added") return "Added back";
  if (host.kind === "removed") return "Removed: it did not exist yet";
  return summarizeFields(host.fields);
}

export function summarizeFields(fields: readonly string[], max = 6): string {
  const unique = [...new Set(fields)];
  if (unique.length === 0) return "Changed";
  const shown = unique.slice(0, max).join(", ");
  return unique.length > max ? `${shown} and ${unique.length - max} more` : shown;
}

/** "this node" or "all 3 nodes". */
export function describeReload(reload: RollbackPreview["reload"]): string {
  return reload.nodes <= 1 ? "this node" : `all ${reload.nodes} nodes`;
}

const BLOCKED_PREFIX = "Protected by an approval policy";
const IDENTICAL_PREFIX = "This version matches the running configuration";

/** The reasons a rollback is not possible that the panel does not already show in a banner. */
export function remainingReasons(preview: Pick<RollbackPreview, "reasons" | "blocked" | "identical">): string[] {
  return preview.reasons.filter(
    (reason) => !reason.startsWith(IDENTICAL_PREFIX) && !(preview.blocked && reason.startsWith(BLOCKED_PREFIX))
  );
}
