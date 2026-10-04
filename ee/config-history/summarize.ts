// SPDX-License-Identifier: Elastic-2.0
/**
 * Computes what a version changed from the one before it (changes.ts), from
 * the full diff of the two configurations.
 */
import type { ConfigContent, ConfigRow, ConfigTableName } from "@/src/lib/config-content";
import { diffConfigContent, type ConfigDiff, type DiffItem } from "./diff";
import { MAX_FIELDS, MAX_STORED_ITEMS, type VersionChangeItem, type VersionChanges } from "./changes";

function rowById(content: ConfigContent | null, table: ConfigTableName, id: number | string): ConfigRow | null {
  if (!content) return null;
  return content.tables[table].find((row) => row.id === id) ?? null;
}

function hostOf(
  table: ConfigTableName | "settings",
  item: DiffItem,
  from: ConfigContent | null,
  to: ConfigContent
): VersionChangeItem["host"] {
  if (table === "proxyHosts" && typeof item.id === "number") return { type: "proxy_host", id: item.id };
  if (table === "l4ProxyHosts" && typeof item.id === "number") return { type: "l4_proxy_host", id: item.id };
  if (table === "mtlsAccessRules" || table === "forwardAuthAccess") {
    const row = rowById(to, table, item.id) ?? rowById(from, table, item.id);
    const hostId = row?.proxyHostId;
    return typeof hostId === "number" ? { type: "proxy_host", id: hostId } : null;
  }
  return null;
}

/** The changes from `from` (null: this is the first version kept) to `to`, and the full diff. */
export function computeVersionChanges(from: ConfigContent | null, to: ConfigContent, previousId: number | null): { changes: VersionChanges; diff: ConfigDiff | null } {
  if (!from) {
    return {
      changes: { previousId: null, initial: true, items: [], truncated: false, totals: { items: 0, fields: 0, hosts: 0, hostsAdded: 0, hostsRemoved: 0, settings: 0, other: 0 } },
      diff: null,
    };
  }
  const diff = diffConfigContent(from, to);
  const items: VersionChangeItem[] = [];
  const hosts = new Set<string>();
  let fields = 0;
  let hostsAdded = 0;
  let hostsRemoved = 0;
  let settings = 0;
  let other = 0;
  for (const entity of diff.entities) {
    const lists: [VersionChangeItem["kind"], (DiffItem & { changes?: { path: string }[] })[]][] = [
      ["added", entity.added],
      ["removed", entity.removed],
      ["changed", entity.changed],
    ];
    for (const [kind, list] of lists) {
      for (const item of list) {
        const host = hostOf(entity.entity, item, from, to);
        const paths = kind === "changed" ? (item.changes ?? []).map((change) => change.path) : [];
        fields += paths.length;
        if (host) hosts.add(`${host.type}:${host.id}`);
        if (entity.entity === "settings") settings += 1;
        else if (!host) other += 1;
        if ((entity.entity === "proxyHosts" || entity.entity === "l4ProxyHosts") && kind === "added") hostsAdded += 1;
        if ((entity.entity === "proxyHosts" || entity.entity === "l4ProxyHosts") && kind === "removed") hostsRemoved += 1;
        items.push({ entity: entity.entity, id: item.id, label: item.label, kind, fields: paths.slice(0, MAX_FIELDS), host });
      }
    }
  }
  return {
    changes: {
      previousId,
      items: items.slice(0, MAX_STORED_ITEMS),
      truncated: items.length > MAX_STORED_ITEMS,
      totals: { items: items.length, fields, hosts: hosts.size, hostsAdded, hostsRemoved, settings, other },
    },
    diff,
  };
}
