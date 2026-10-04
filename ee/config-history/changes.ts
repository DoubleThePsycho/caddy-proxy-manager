// SPDX-License-Identifier: Elastic-2.0
/**
 * What one configuration version changed, in a compact form stored with the
 * version (config_snapshots.changes), and which configuration entity an
 * audit event is about. Free of database and server imports: the audit log
 * (src/lib/audit-chain.ts) and client components can use it.
 */
import type { ConfigSettingKey, ConfigTableName } from "@/src/lib/config-content";

export type ChangeEntity = ConfigTableName | "settings";
export type HostType = "proxy_host" | "l4_proxy_host";

export type VersionChangeItem = {
  entity: ChangeEntity;
  id: number | string;
  label: string;
  kind: "added" | "removed" | "changed";
  /** Field paths that changed (changed items only; at most MAX_FIELDS). */
  fields: string[];
  /** The host the row belongs to: the host itself, or the host of an mTLS rule or forward-auth grant. */
  host: { type: HostType; id: number } | null;
};

export type VersionChanges = {
  /** The version these changes are counted from; null for the first version kept. */
  previousId: number | null;
  /** The first version kept: there is nothing to compare it with. */
  initial?: boolean;
  items: VersionChangeItem[];
  /** More items changed than are stored. */
  truncated: boolean;
  /**
   * items: every changed row or settings group; hosts: distinct hosts touched
   * (rows of a host count once); other: rows that belong to no host;
   * fields: changed fields of changed items (an added or removed item counts none).
   */
  totals: { items: number; fields: number; hosts: number; hostsAdded: number; hostsRemoved: number; settings: number; other: number };
};

export const MAX_STORED_ITEMS = 500;
export const MAX_FIELDS = 50;

/** The configuration entity an audit event is about. */
export type ConfigEntityRef =
  | { kind: "row"; table: ConfigTableName; id: number | null }
  | { kind: "settings"; key: ConfigSettingKey | null }
  | { kind: "all" };

const ROW_ENTITIES: Record<string, ConfigTableName> = {
  proxy_host: "proxyHosts",
  l4_proxy_host: "l4ProxyHosts",
  access_list: "accessLists",
  access_list_entry: "accessListEntries",
  certificate: "certificates",
  ca_certificate: "caCertificates",
  issued_client_certificate: "issuedClientCertificates",
  mtls_role: "mtlsRoles",
  mtls_certificate_role: "mtlsCertificateRoles",
  mtls_access_rule: "mtlsAccessRules",
  group: "groups",
  forward_auth_access: "forwardAuthAccess",
};

/** Actions that replace the whole configuration. */
const WHOLE_CONFIGURATION_ACTIONS = new Set(["config_imported", "config_restored", "config_backup_restored"]);

/** Actions on configuration entities that change nothing (checks, exports, failures, other settings). */
const NOT_A_CHANGE = /(_tested|_previewed|_exported|_failed|_viewed)$|^mfa_policy_updated$/;

/** The configuration entity an audit event changed, or null when it changed none. */
export function configEntityOf(event: { action: string; entityType: string; entityId?: number | null }): ConfigEntityRef | null {
  if (WHOLE_CONFIGURATION_ACTIONS.has(event.action)) return { kind: "all" };
  if (NOT_A_CHANGE.test(event.action)) return null;
  if (event.entityType === "setting") return { kind: "settings", key: null };
  if (event.entityType === "certificate_storage") return { kind: "settings", key: "certificate_storage" };
  const table = ROW_ENTITIES[event.entityType];
  return table ? { kind: "row", table, id: event.entityId ?? null } : null;
}

/** Whether `item` is (part of) the entity. A proxy host includes its mTLS rules and forward-auth grants. */
export function itemMatchesEntity(item: Pick<VersionChangeItem, "entity" | "id" | "host">, entity: ConfigEntityRef): boolean {
  if (entity.kind === "all") return true;
  if (entity.kind === "settings") return item.entity === "settings" && (entity.key === null || item.id === entity.key);
  if (entity.id === null) return item.entity === entity.table;
  if (item.entity === entity.table && item.id === entity.id) return true;
  return entity.table === "proxyHosts" && item.host?.type === "proxy_host" && item.host.id === entity.id;
}

export function changesTouchEntity(changes: VersionChanges, entity: ConfigEntityRef): boolean {
  if (entity.kind === "all") return changes.totals.items > 0;
  return changes.items.some((item) => itemMatchesEntity(item, entity));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stored changes; null when missing or unreadable (they are computed again). */
export function parseVersionChanges(text: string | null | undefined): VersionChanges | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    if (!isRecord(value) || !Array.isArray(value.items) || !isRecord(value.totals)) return null;
    return value as VersionChanges;
  } catch {
    return null;
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** e.g. "1 host · 2 fields", "1 host added · 3 fields", "2 settings groups · 4 fields", "No changes". */
export function describeChangeSize(changes: Pick<VersionChanges, "totals" | "initial">): string {
  const t = changes.totals;
  if (changes.initial) return "First version";
  if (t.items === 0) return "No changes";
  const parts: string[] = [];
  if (t.hosts > 0) {
    if (t.hosts === 1 && t.hostsAdded === 1) parts.push("1 host added");
    else if (t.hosts === 1 && t.hostsRemoved === 1) parts.push("1 host removed");
    else parts.push(plural(t.hosts, "host", "hosts"));
  }
  if (t.settings > 0) parts.push(plural(t.settings, "settings group", "settings groups"));
  const other = t.other ?? 0;
  if (other > 0) parts.push(parts.length > 0 ? plural(other, "other item", "other items") : plural(other, "item", "items"));
  if (t.fields > 0) parts.push(plural(t.fields, "field", "fields"));
  return parts.join(" · ");
}
