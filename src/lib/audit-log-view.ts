/**
 * What the audit log page passes from the server to the client, and the
 * small pure helpers both sides share (filters in the URL, labels). Safe to
 * import from client components.
 */
import type { AuditChangeDiff } from "@/ee/config-history/versions";

export const AUDIT_RANGES = ["1h", "24h", "7d", "30d"] as const;
export type AuditRange = (typeof AUDIT_RANGES)[number] | "all";

export const RANGE_MS: Record<(typeof AUDIT_RANGES)[number], number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export const RANGE_TEXT: Record<AuditRange, string> = {
  "1h": "in the last hour",
  "24h": "in the last 24 hours",
  "7d": "in the last 7 days",
  "30d": "in the last 30 days",
  all: "",
};

export function isAuditRange(value: unknown): value is AuditRange {
  return value === "all" || (AUDIT_RANGES as readonly unknown[]).includes(value);
}

/** The filters as they are in the URL (strings; empty when unset). */
export type AuditFilters = {
  q: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  range: AuditRange;
  from: string;
  to: string;
  page: number;
};

export const EMPTY_FILTERS: AuditFilters = { q: "", actor: "", action: "", entityType: "", entityId: "", range: "all", from: "", to: "", page: 1 };

/** The audit log URL for these filters; empty values and the defaults are left out. */
export function auditLogHref(filters: Partial<AuditFilters>, pathname = "/audit-log"): string {
  const params = new URLSearchParams();
  const set = (key: string, value: string | undefined) => {
    if (value && value.trim()) params.set(key, value.trim());
  };
  set("q", filters.q);
  set("actor", filters.actor);
  set("action", filters.action);
  set("entityType", filters.entityType);
  set("entityId", filters.entityId);
  if (filters.range && filters.range !== "all") params.set("range", filters.range);
  set("from", filters.from);
  set("to", filters.to);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** Whether anything narrows the events beyond the time range. */
export function hasNarrowingFilters(filters: AuditFilters): boolean {
  return Boolean(filters.q || filters.actor || filters.action || filters.entityType || filters.entityId);
}

export type AuditActor = {
  kind: "user" | "system" | "deleted";
  /** What the table shows. */
  name: string;
  email: string | null;
};

export type AuditEventRow = {
  id: number;
  createdAt: string;
  userId: number | null;
  actor: AuditActor;
  action: string;
  entityType: string;
  entityId: number | null;
  summary: string | null;
  hash: string | null;
  prevHash: string | null;
  configChange: { beforeId: number | null; afterId: number | null; changeRequestId: number | null; pending: boolean } | null;
};

export type AuditFacetsView = {
  actors: { value: string; label: string; events: number }[];
  actions: string[];
  entityTypes: string[];
};

/** One event's detail, loaded when its row is expanded. */
export type AuditEventDetail = {
  id: number;
  data: unknown;
  configDiff: AuditChangeDiff | null;
  /** The chained event before it. */
  previousEventId: number | null;
};

const ENTITY_LABELS: Record<string, string> = {
  proxy_host: "Proxy host",
  l4_proxy_host: "L4 host",
  access_list: "Access list",
  access_list_entry: "Access list entry",
  access_list_rule: "Access list rule",
  certificate: "Certificate",
  ca_certificate: "CA certificate",
  client_certificate: "Client certificate",
  issued_client_certificate: "Client certificate",
  mtls_role: "mTLS role",
  alert_rule: "Alert rule",
  alert_channel: "Alert channel",
  alert_silence: "Alert mute or dismissal",
  setting: "Setting",
  settings: "Settings",
  user: "User",
  group: "Group",
  api_token: "API token",
  audit_log: "Audit log",
  audit_sink: "Audit sink",
  config_snapshot: "Configuration version",
  config_history: "Configuration history",
  configuration: "Configuration",
  change_request: "Change request",
  approval_policy: "Approval policy",
  backup_destination: "Backup destination",
  instance: "Instance",
  license: "License",
  waf: "WAF",
};

/** proxy_host → "Proxy host"; unknown types are made readable the same way. */
export function entityTypeLabel(type: string): string {
  const known = ENTITY_LABELS[type];
  if (known) return known;
  const words = type.replace(/[_.:-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : type;
}

/** Actions about something that went wrong or was refused, tinted as a warning. */
export function isFailureAction(action: string): boolean {
  return /(fail|denied|mismatch|refused|reject|invalid|locked|blocked|expired|revoked)/i.test(action);
}

/** "4be1a07c…9d2f61e3" */
export function shortHash(hash: string | null | undefined): string {
  if (!hash) return "None";
  return hash.length > 20 ? `${hash.slice(0, 8)}…${hash.slice(-8)}` : hash;
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
