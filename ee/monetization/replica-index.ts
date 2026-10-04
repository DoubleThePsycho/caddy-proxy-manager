// SPDX-License-Identifier: Elastic-2.0
/**
 * What a master sends its sync replicas (and fleet pull replicas) so that
 * they can serve monetized hosts: the settings group "monetization_replica"
 * of the sync payload. Pure: no database, no network.
 *
 * A replica serves a monetized host only when it can gate it with the
 * master's balances:
 *
 *  - "shared": through the high availability shared state (Redis or Valkey)
 *    the master uses, with the master's key namespace; the replica charges
 *    the same balances with the same atomic scripts as the master's nodes.
 *  - "allowance": by asking the master's gate for short-lived allowances
 *    (replica-allowance.ts), which the master charges before granting.
 *
 * The section carries the gate's index without balances (plans, consumers
 * with their status and billing state, API keys as SHA-256 digests, the
 * monetized hosts) and the monetized proxy hosts themselves. Older replicas
 * do not know the group and ignore it, so they never serve those hosts at
 * all; a replica that knows it inserts them only with the gate in front.
 * The key digests are sealed to the replica's sync key in transit and stored
 * encrypted there (as every secret in synced settings).
 */
import { SUSPENSION_REASONS, type BillingMode, type ReplicaMode } from "./types";

export const REPLICA_SETTING_KEY = "monetization_replica";
export const REPLICA_INDEX_VERSION = 1;

export type ReplicaPlan = {
  id: number;
  name: string;
  priceMicros: number;
  includedPerMonth: number;
  perMinute: number | null;
  billing: BillingMode;
  capMicros: number | null;
  creditFailed: boolean;
};

export type ReplicaConsumer = {
  id: number;
  active: boolean;
  planId: number | null;
  overdraftMicros: number;
  billing: BillingMode | null;
  hasCard: boolean;
  cardExpMonth: number | null;
  cardExpYear: number | null;
  suspended: string | null;
};

/** hash: the key's SHA-256 (hex); encrypted while stored. */
export type ReplicaKey = { id: number; consumerId: number; prefix: string; hash: string };

export type ReplicaHost = { proxyHostId: number; keyHeader: string; allowedPlanIds: number[] };

export type ReplicaIndexValue = {
  v: typeof REPLICA_INDEX_VERSION;
  mode: Exclude<ReplicaMode, "off">;
  /** shared: the master's shared-state namespace. */
  namespace: string | null;
  /** allowance: the master's base URL for /api/monetization/replica/allowance. */
  gateUrl: string | null;
  currency: string;
  /** Where 402 answers send consumers: the master's portal. */
  topUpUrl: string;
  hosts: ReplicaHost[];
  plans: ReplicaPlan[];
  consumers: ReplicaConsumer[];
  keys: ReplicaKey[];
  /** The monetized proxy hosts' rows, and their WAF rule exclusions, as data.proxyHosts carries other hosts. */
  proxyHosts: Array<Record<string, unknown>>;
  wafRuleExclusions: Array<Record<string, unknown>>;
};

const LIMITS = { hosts: 10_000, plans: 10_000, consumers: 200_000, keys: 1_000_000 } as const;
const NAMESPACE = /^[A-Za-z0-9._-]{1,64}:[a-f0-9]{8,32}:$/;
const PREFIX = /^ik_[a-f0-9]{12}$/;
const HEADER = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const MONTH_OR_NULL = (value: unknown) => value === null || (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 12);
const YEAR_OR_NULL = (value: unknown) => value === null || (Number.isInteger(value) && (value as number) >= 2000 && (value as number) <= 2200);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBilling(value: unknown): value is BillingMode {
  return value === "prepaid" || value === "postpaid";
}

function webUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

/**
 * Whether a replica may send its allowance credential to `value`: an https
 * URL without credentials, query or fragment; http only where plain HTTP
 * sync is allowed (INSTANCE_SYNC_ALLOW_HTTP, for test and lab setups), the
 * same rule as the sync itself.
 */
export function isGateUrlAllowed(value: unknown, allowHttp: boolean): boolean {
  const url = webUrl(value);
  if (!url || url.search || url.hash) return false;
  return url.protocol === "https:" || (allowHttp && url.protocol === "http:");
}

/** Where 402 answers send consumers: an http(s) URL, or a path on the master's dashboard; nothing that could break a header. */
function isLink(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 2048 || /[\s\p{Cc}<>]/u.test(value)) return false;
  return value.startsWith("/") || webUrl(value) !== null;
}

function isPlan(value: unknown): value is ReplicaPlan {
  return (
    isRecord(value) &&
    isId(value.id) &&
    typeof value.name === "string" &&
    isAmount(value.priceMicros) &&
    isAmount(value.includedPerMonth) &&
    (value.perMinute === null || isId(value.perMinute)) &&
    isBilling(value.billing) &&
    (value.capMicros === null || isAmount(value.capMicros)) &&
    typeof value.creditFailed === "boolean"
  );
}

function isConsumer(value: unknown): value is ReplicaConsumer {
  return (
    isRecord(value) &&
    isId(value.id) &&
    typeof value.active === "boolean" &&
    (value.planId === null || isId(value.planId)) &&
    isAmount(value.overdraftMicros) &&
    (value.billing === null || isBilling(value.billing)) &&
    typeof value.hasCard === "boolean" &&
    MONTH_OR_NULL(value.cardExpMonth) &&
    YEAR_OR_NULL(value.cardExpYear) &&
    (value.suspended === null || (SUSPENSION_REASONS as readonly unknown[]).includes(value.suspended))
  );
}

/** hash is a string: sealed or encrypted where the shape is checked; checked again once opened. */
function isKey(value: unknown): value is ReplicaKey {
  return isRecord(value) && isId(value.id) && isId(value.consumerId) && typeof value.prefix === "string" && PREFIX.test(value.prefix) && typeof value.hash === "string" && value.hash.length <= 4096;
}

function isHost(value: unknown): value is ReplicaHost {
  return (
    isRecord(value) &&
    isId(value.proxyHostId) &&
    typeof value.keyHeader === "string" &&
    HEADER.test(value.keyHeader) &&
    Array.isArray(value.allowedPlanIds) &&
    value.allowedPlanIds.length <= 100 &&
    value.allowedPlanIds.every(isId)
  );
}

/**
 * Why a received section is not usable, or null. `isProxyHost`,
 * `isWafRuleExclusion` and `proxyHostContentError` are the checks the sync
 * payload's own rows go through (src/lib/instance-sync-validation.ts);
 * `allowHttpGate`: whether this replica allows plain HTTP sync, and so a
 * plain HTTP gate URL.
 */
export function replicaSectionError(
  value: unknown,
  checks: {
    isProxyHost: (row: unknown) => boolean;
    isWafRuleExclusion: (row: unknown) => boolean;
    proxyHostContentError: (row: Record<string, unknown>) => string | null;
    allowHttpGate?: boolean;
  }
): string | null {
  if (value === null || value === undefined) return null;
  const invalid = "Invalid API monetization replica section";
  if (!isRecord(value) || value.v !== REPLICA_INDEX_VERSION) return invalid;
  if (value.mode !== "shared" && value.mode !== "allowance") return invalid;
  if (value.mode === "shared" && !(typeof value.namespace === "string" && NAMESPACE.test(value.namespace))) return invalid;
  if (value.mode === "allowance" && !isGateUrlAllowed(value.gateUrl, checks.allowHttpGate === true)) {
    return "The API monetization gate URL must use https (or http with INSTANCE_SYNC_ALLOW_HTTP=true)";
  }
  if (typeof value.currency !== "string" || !/^[a-z]{3}$/.test(value.currency) || !isLink(value.topUpUrl)) return invalid;
  for (const [field, check, limit] of [
    ["hosts", isHost, LIMITS.hosts],
    ["plans", isPlan, LIMITS.plans],
    ["consumers", isConsumer, LIMITS.consumers],
    ["keys", isKey, LIMITS.keys],
  ] as const) {
    const list = value[field];
    if (!Array.isArray(list) || list.length > limit || !list.every((item) => (check as (item: unknown) => boolean)(item))) return invalid;
  }
  if (!Array.isArray(value.proxyHosts) || !value.proxyHosts.every(checks.isProxyHost)) return invalid;
  if (!Array.isArray(value.wafRuleExclusions) || !value.wafRuleExclusions.every(checks.isWafRuleExclusion)) return invalid;
  const hostIds = new Set((value.hosts as ReplicaHost[]).map((host) => host.proxyHostId));
  for (const row of value.proxyHosts as Array<Record<string, unknown>>) {
    // Only hosts the section gates: a row the gate does not know would be served ungated.
    if (!hostIds.has(row.id as number)) return invalid;
    const error = checks.proxyHostContentError(row);
    if (error) return error;
  }
  for (const row of value.wafRuleExclusions as Array<Record<string, unknown>>) {
    if (row.proxyHostId === null || !hostIds.has(row.proxyHostId as number)) return invalid;
  }
  return null;
}

/** The section as stored (after replicaSectionError passed), or null. Key hashes as stored (decrypt before use). */
export function parseReplicaSection(value: unknown): ReplicaIndexValue | null {
  if (!isRecord(value) || value.v !== REPLICA_INDEX_VERSION || (value.mode !== "shared" && value.mode !== "allowance")) return null;
  const list = <T>(field: string, check: (item: unknown) => item is T): T[] | null => {
    const items = value[field];
    return Array.isArray(items) && items.every(check) ? (items as T[]) : null;
  };
  const hosts = list("hosts", isHost);
  const plans = list("plans", isPlan);
  const consumers = list("consumers", isConsumer);
  const keys = list("keys", isKey);
  if (!hosts || !plans || !consumers || !keys) return null;
  if (typeof value.currency !== "string" || typeof value.topUpUrl !== "string") return null;
  return {
    v: REPLICA_INDEX_VERSION,
    mode: value.mode,
    namespace: typeof value.namespace === "string" ? value.namespace : null,
    gateUrl: typeof value.gateUrl === "string" ? value.gateUrl : null,
    currency: value.currency,
    topUpUrl: value.topUpUrl,
    hosts,
    plans,
    consumers,
    keys,
    proxyHosts: Array.isArray(value.proxyHosts) ? (value.proxyHosts as Array<Record<string, unknown>>) : [],
    wafRuleExclusions: Array.isArray(value.wafRuleExclusions) ? (value.wafRuleExclusions as Array<Record<string, unknown>>) : [],
  };
}
