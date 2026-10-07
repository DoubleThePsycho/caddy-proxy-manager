// SPDX-License-Identifier: Elastic-2.0
/**
 * Allowances: how a sync replica (or fleet pull replica) gates monetized
 * hosts with its master's balances when the two share no Redis or Valkey.
 *
 * The replica checks a request against the index the master sent (key,
 * consumer, plan, host; replica-index.ts) and admits it from a short-lived
 * allowance: a number of requests the master reserved for it. When the
 * allowance is used up or expires it asks the master's gate for the next one
 * (POST /api/monetization/replica/allowance), reporting how much of the
 * previous one it used.
 *
 * Authentication: an allowance credential derived from the replica's sync
 * secret (HMAC-SHA256 with ALLOWANCE_CREDENTIAL_INFO: of a pushed slave's
 * sync token, of a pull replica's fingerprint token), which the master
 * recomputes per replica. It opens this endpoint only: whoever reads it (the
 * gate URL is configuration the master sends) cannot push configuration to
 * the slave nor fetch the master's. The sync token itself never leaves for
 * the gate URL. The endpoint is rate limited by client address before any
 * credential is looked at, and finds the replica through an index of
 * credential digests (one decryption to confirm, not one per replica).
 *
 * What a replica may reserve: only while the master serves monetized hosts
 * with allowances (Settings), only for a host it was sent (replica-hosts.ts),
 * and only for an API key it was presented: the replica forwards the key the
 * client sent, which the master checks against its own index in constant
 * time, so a replica cannot charge a consumer by naming it. Allowances not
 * reported yet are capped per node of the replica (each process of it names
 * itself, so a replica run on several nodes gets a share per node) and per
 * consumer on each node, and a replica may use at most MAX_NODES_PER_REPLICA
 * node names at once: what a compromised replica can have charged without
 * using it is bounded per window (MAX_UNREPORTED_REQUESTS_PER_CONSUMER).
 *
 * The master reserves an allowance exactly as it would charge that many
 * requests at its own gate (engine.ts reserveRequests, or the shared store's
 * MZ_RESERVE): the per-minute window, free requests first, then the price,
 * only while the balance stays within the overdraft allowance or postpaid
 * cap. The replica never admits more than it was granted, nor after the
 * allowance expired. So every request a replica admits was charged on the
 * master before it was admitted, and the unpaid exposure is bounded by the
 * same limit as at the master's own gate, however many replicas run and
 * whatever they do. What a replica reports unused goes back to the consumer
 * (once per allowance, never more than was reserved); an allowance whose
 * report never comes (the replica stopped) stays charged: the consumer pays
 * for at most MAX_LEASE_REQUESTS requests it did not make per allowance.
 *
 * Caveats: a key revoked or a consumer disabled on the master is refused by
 * a replica when its allowance runs out (at most LEASE_TTL_MS) or with the
 * next sync, whichever is first; failed answers on such a replica are not
 * credited back. The master unreachable: requests are refused (503).
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { fleetPullReplicas, instances } from "@/src/lib/db/schema";
import { first } from "@/src/lib/db/ops";
import { withClusterLock } from "@/src/lib/db/locks";
import { decryptSecret } from "@/src/lib/secret";
import { defineRuntimeEntries } from "@/src/lib/shared-runtime-state";
import { createRateLimiter } from "@/src/lib/rate-limit";
import { getClientIp, ipRateLimitBucket } from "@/src/lib/client-ip";
import {
  ensureMonetizationLoaded,
  precheckGate,
  precheckReplicaRequest,
  presentedKeyOf,
  type GateDecision,
  type GateDenial,
} from "./engine";
import type { MonetizationBalanceStore } from "./balance-store";
import { readSuspensionReason } from "./types";

export const ALLOWANCE_PATH = "/api/monetization/replica/allowance";
/** Requests one allowance covers at most (also capped by the plan's per-minute limit). */
export const MAX_LEASE_REQUESTS = 50;
/** How long a replica may use an allowance. */
export const LEASE_TTL_MS = 30_000;
/** How long the master remembers an allowance for its report. */
const LEASE_MEMORY_MS = LEASE_TTL_MS + 5 * 60_000;
/** Allowances one node of a replica holds unreported per consumer, and in all. */
export const MAX_UNREPORTED_PER_CONSUMER = 4;
export const MAX_UNREPORTED_PER_NODE = 20_000;
/** Node names a replica may use within the master's memory of its allowances. */
export const MAX_NODES_PER_REPLICA = 16;
/**
 * The bound: requests a replica, whatever it does, can have reserved for one
 * consumer without reporting them within the master's memory of its
 * allowances (LEASE_MEMORY_MS, five and a half minutes), each also within the
 * consumer's balance or cap and its plan's per-minute limit. It is a rate,
 * not a total: once allowances drop out of that memory their places come
 * back, so a replica that never reports can keep reserving that many every
 * window. No total is needed: whoever holds a consumer's key can spend its
 * balance just as fast through the public gate.
 */
export const MAX_UNREPORTED_REQUESTS_PER_CONSUMER = MAX_NODES_PER_REPLICA * MAX_UNREPORTED_PER_CONSUMER * MAX_LEASE_REQUESTS;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_REPORTS = 100;
const MAX_KEY_LENGTH = 128;

/** Separates the allowance credential from anything else derived from a sync secret. */
export const ALLOWANCE_CREDENTIAL_INFO = "ingressi:monetization-allowance:v1";
const CREDENTIAL = /^mza_[A-Za-z0-9_-]{43}$/;

/**
 * The allowance credential of a replica: HMAC-SHA256 of ALLOWANCE_CREDENTIAL_INFO
 * keyed with its sync secret (a pushed slave's sync token, a pull replica's
 * fingerprint token, see pullFingerprintToken). Opens the allowance endpoint
 * only.
 */
export function deriveAllowanceCredential(syncSecret: string): string {
  return `mza_${createHmac("sha256", syncSecret).update(ALLOWANCE_CREDENTIAL_INFO).digest("base64url")}`;
}

// ── Master: who is asking ────────────────────────────────────────────

/** Failed authentications per client address (an /64 for IPv6) and minute. */
const addressLimiter = createRateLimiter({ name: "monetization-allowance-address", maxAttempts: 30, windowMs: 60_000, blockMs: "window" });
const replicaLimiter = createRateLimiter({ name: "monetization-allowance", maxAttempts: 6_000, windowMs: 60_000, blockMs: "window" });

type CredentialSource = { kind: "push"; instanceId: number } | { kind: "pull"; instanceId: number } | { kind: "env"; index: number };
type AuthIndex = { builtAt: number; byDigest: Map<string, CredentialSource> };

const INDEX_TTL_MS = 60_000;
/** A credential the index does not know rebuilds it at most this often. */
const MIN_REBUILD_MS = 5_000;
const indexStore = globalThis as typeof globalThis & { __ingressiAllowanceAuth?: { index: AuthIndex | null; building: Promise<AuthIndex> | null } };
function authState(): { index: AuthIndex | null; building: Promise<AuthIndex> | null } {
  return (indexStore.__ingressiAllowanceAuth ??= { index: null, building: null });
}

function digestHex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameCredential(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

function tryDecrypt(value: string | null, label: string): string | null {
  if (!value) return null;
  try {
    return decryptSecret(value, label) || null;
  } catch {
    return null;
  }
}

async function buildAuthIndex(now: number): Promise<AuthIndex> {
  const byDigest = new Map<string, CredentialSource>();
  const pushed = await appDb
    .select({ id: instances.id, apiToken: instances.apiToken })
    .from(instances)
    .where(and(eq(instances.enabled, true), eq(instances.syncMode, "push")));
  for (const row of pushed) {
    const token = tryDecrypt(row.apiToken, "instance sync token");
    if (token) byDigest.set(digestHex(deriveAllowanceCredential(token)), { kind: "push", instanceId: row.id });
  }
  const pulled = await appDb
    .select({ id: fleetPullReplicas.instanceId, fingerprintToken: fleetPullReplicas.fingerprintToken })
    .from(fleetPullReplicas)
    .innerJoin(instances, eq(instances.id, fleetPullReplicas.instanceId))
    .where(and(eq(instances.enabled, true), eq(instances.syncMode, "pull"), isNotNull(fleetPullReplicas.fingerprintToken)));
  for (const row of pulled) {
    const token = tryDecrypt(row.fingerprintToken, "pull replica fingerprint token");
    if (token) byDigest.set(digestHex(deriveAllowanceCredential(token)), { kind: "pull", instanceId: row.id });
  }
  const { getEnvSlaveInstances } = await import("@/src/lib/instance-sync");
  getEnvSlaveInstances().forEach((slave, index) => {
    byDigest.set(digestHex(deriveAllowanceCredential(slave.token)), { kind: "env", index });
  });
  return { builtAt: now, byDigest };
}

async function authIndex(now: number, rebuild: boolean): Promise<AuthIndex> {
  const auth = authState();
  if (auth.index && !rebuild && now - auth.index.builtAt < INDEX_TTL_MS) return auth.index;
  if (!auth.building) {
    auth.building = buildAuthIndex(now)
      .then((index) => {
        auth.index = index;
        return index;
      })
      .finally(() => {
        auth.building = null;
      });
  }
  return await auth.building;
}

/** Confirms a credential against the one replica the index named: one decryption, compared in constant time. */
async function confirm(source: CredentialSource, presented: string): Promise<{ instanceId: number } | null> {
  if (source.kind === "env") {
    const { getEnvSlaveInstances } = await import("@/src/lib/instance-sync");
    const slave = getEnvSlaveInstances()[source.index];
    return slave && sameCredential(deriveAllowanceCredential(slave.token), presented) ? { instanceId: -(source.index + 1) } : null;
  }
  if (source.kind === "push") {
    const row = await first(appDb.select().from(instances).where(eq(instances.id, source.instanceId)).limit(1));
    if (!row || !row.enabled || row.syncMode !== "push") return null;
    const token = tryDecrypt(row.apiToken, "instance sync token");
    return token && sameCredential(deriveAllowanceCredential(token), presented) ? { instanceId: row.id } : null;
  }
  const row = await first(appDb
    .select({ id: instances.id, enabled: instances.enabled, syncMode: instances.syncMode, fingerprintToken: fleetPullReplicas.fingerprintToken })
    .from(fleetPullReplicas)
    .innerJoin(instances, eq(instances.id, fleetPullReplicas.instanceId))
    .where(eq(fleetPullReplicas.instanceId, source.instanceId))
    .limit(1));
  if (!row || !row.enabled || row.syncMode !== "pull") return null;
  const token = tryDecrypt(row.fingerprintToken, "pull replica fingerprint token");
  return token && sameCredential(deriveAllowanceCredential(token), presented) ? { instanceId: row.id } : null;
}

/** The replica behind an allowance credential (see deriveAllowanceCredential), or null. */
export async function authenticateReplica(authorization: string | null, now: number = Date.now()): Promise<{ instanceId: number } | null> {
  const match = authorization?.match(/^Bearer\s+(\S+)\s*$/i);
  if (!match || !CREDENTIAL.test(match[1])) return null;
  const presented = match[1];
  const digest = digestHex(presented);
  let index = await authIndex(now, false);
  let source = index.byDigest.get(digest);
  if (!source && now - index.builtAt >= MIN_REBUILD_MS) {
    index = await authIndex(now, true);
    source = index.byDigest.get(digest);
  }
  return source ? await confirm(source, presented) : null;
}

/** Tests only. */
export function resetAllowanceAuthForTests(): void {
  indexStore.__ingressiAllowanceAuth = { index: null, building: null };
}

// ── Master: granting allowances ──────────────────────────────────────

type StoredLease = { instanceId: number; node: string; consumerId: number; granted: number; free: number; priceMicros: number; month: string; minute: number };

const leases = defineRuntimeEntries<StoredLease>("monetization-lease", {
  maxEntries: 100_000,
  isValue: (value): value is StoredLease => {
    if (typeof value !== "object" || value === null) return false;
    const lease = value as Record<string, unknown>;
    return [lease.instanceId, lease.consumerId, lease.granted, lease.free, lease.priceMicros, lease.minute].every((n) => Number.isSafeInteger(n)) && typeof lease.month === "string" && typeof lease.node === "string";
  },
});

/** Allowances not reported yet, counted per minute they were granted in (older minutes drop off). */
type Outstanding = { b: Record<string, number> };
const outstanding = defineRuntimeEntries<Outstanding>("monetization-lease-count", {
  maxEntries: 100_000,
  isValue: (value): value is Outstanding =>
    typeof value === "object" && value !== null && typeof (value as Outstanding).b === "object" && (value as Outstanding).b !== null &&
    Object.values((value as Outstanding).b).every((n) => Number.isSafeInteger(n)),
});

const NODE = /^[A-Za-z0-9._:-]{1,40}$/;

/** The node names a replica used within the master's memory of its allowances (name: last minute). */
type NodeRegistry = { nodes: Record<string, number> };
const nodeRegistry = defineRuntimeEntries<NodeRegistry>("monetization-lease-nodes", {
  maxEntries: 10_000,
  isValue: (value): value is NodeRegistry =>
    typeof value === "object" && value !== null && typeof (value as NodeRegistry).nodes === "object" && (value as NodeRegistry).nodes !== null &&
    Object.values((value as NodeRegistry).nodes).every((n) => Number.isSafeInteger(n)),
});

async function liveNodes(instanceId: number, now: number): Promise<Record<string, number>> {
  const oldest = Math.floor((now - LEASE_MEMORY_MS) / 60_000);
  return Object.fromEntries(Object.entries((await nodeRegistry.get(`r:${instanceId}`))?.nodes ?? {}).filter(([, minute]) => minute >= oldest));
}

function liveBuckets(entry: Outstanding | null, now: number): Record<string, number> {
  const oldest = Math.floor((now - LEASE_MEMORY_MS) / 60_000);
  return Object.fromEntries(Object.entries(entry?.b ?? {}).filter(([minute, count]) => Number(minute) >= oldest && count > 0));
}

function total(buckets: Record<string, number>): number {
  return Object.values(buckets).reduce((sum, count) => sum + count, 0);
}

async function changeOutstanding(key: string, minute: number, delta: number, now: number): Promise<void> {
  const buckets = liveBuckets(await outstanding.get(key), now);
  const next = Math.max(0, (buckets[minute] ?? 0) + delta);
  if (next > 0) buckets[minute] = next;
  else delete buckets[minute];
  if (Object.keys(buckets).length === 0) await outstanding.delete(key);
  else await outstanding.put(key, { b: buckets }, LEASE_MEMORY_MS);
}

export type GrantedLease = { id: string; granted: number; free: number; priceMicros: number; planId: number; ttlMs: number };

export type AllowanceReply = { lease: GrantedLease } | { denied: GateDenial } | { reported: number };

type AllowanceReport = { leaseId: string; used: number };

/**
 * An allowance for a client's request (with reports of earlier ones), or
 * reports alone. `key`: the API key the client presented; `node`: the name
 * of the replica's node (process) asking.
 */
type AllowanceRequest =
  | { kind: "lease"; hostId: number; key: string; want: number; node: string; reports: AllowanceReport[] }
  | { kind: "report"; reports: AllowanceReport[] };

function readId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** The request body, or null when it is not one. */
export function parseAllowanceRequest(body: unknown): AllowanceRequest | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (record.v !== 1) return null;
  const reportsRaw = record.reports === undefined ? [] : record.reports;
  if (!Array.isArray(reportsRaw) || reportsRaw.length > MAX_REPORTS) return null;
  const reports: AllowanceReport[] = [];
  for (const item of reportsRaw) {
    if (typeof item !== "object" || item === null) return null;
    const report = item as Record<string, unknown>;
    if (typeof report.leaseId !== "string" || !/^[0-9a-f-]{36}$/.test(report.leaseId)) return null;
    if (typeof report.used !== "number" || !Number.isSafeInteger(report.used) || report.used < 0) return null;
    reports.push({ leaseId: report.leaseId, used: report.used });
  }
  if (record.reportOnly === true) return { kind: "report", reports };
  const hostId = readId(record.hostId);
  const want = readId(record.want);
  const key = typeof record.key === "string" && record.key.length > 0 && record.key.length <= MAX_KEY_LENGTH && /^[\x21-\x7e]+$/.test(record.key) ? record.key : null;
  const node = typeof record.node === "string" && NODE.test(record.node) ? record.node : null;
  if (!hostId || !want || !key || !node) return null;
  return { kind: "lease", hostId, key, want: Math.min(want, MAX_LEASE_REQUESTS), node, reports };
}

/**
 * Gives back what a replica did not use of its allowances: once per
 * allowance (taken from the registry), only allowances of this replica, and
 * never more than was reserved. Called under the replica's lease lock.
 */
async function settleReportsLocked(store: MonetizationBalanceStore, instanceId: number, reports: AllowanceReport[], now: number): Promise<void> {
  for (const report of reports) {
    // Only the replica it was granted to may report it; taken once.
    const known = await leases.get(report.leaseId);
    if (!known || known.instanceId !== instanceId) continue;
    const lease = await leases.take(report.leaseId);
    if (!lease) continue;
    await changeOutstanding(`c:${instanceId}:${lease.node}:${lease.consumerId}`, lease.minute, -1, now);
    await changeOutstanding(`n:${instanceId}:${lease.node}`, lease.minute, -1, now);
    const used = Math.min(report.used, lease.granted);
    const usedFree = Math.min(used, lease.free);
    const unusedFree = lease.free - usedFree;
    const unusedCharged = lease.granted - lease.free - (used - usedFree);
    await store.release(lease.consumerId, lease.month, {
      granted: unusedFree + unusedCharged,
      free: unusedFree,
      chargedMicros: unusedCharged * lease.priceMicros,
    });
  }
}

async function settleReports(store: MonetizationBalanceStore, instanceId: number, reports: AllowanceReport[], now: number = Date.now()): Promise<void> {
  if (reports.length === 0) return;
  await withClusterLock(`monetization-lease:${instanceId}`, () => settleReportsLocked(store, instanceId, reports, now));
}

const UNAVAILABLE: GateDenial = { allow: false, status: 503, error: "unavailable" };

/** One allowance request on the master. */
export async function grantAllowance(instanceId: number, request: AllowanceRequest, now: number = Date.now()): Promise<AllowanceReply> {
  await ensureMonetizationLoaded();
  const { monetizationBalanceStore } = await import("./balance-store");
  const store = await monetizationBalanceStore();
  await settleReports(store, instanceId, request.reports, now);
  if (request.kind === "report") return { reported: request.reports.length };
  // Only while this master serves monetized hosts with allowances.
  const { getMonetizationOptions } = await import("./options");
  if ((await getMonetizationOptions()).replicaMode !== "allowance") return { denied: UNAVAILABLE };
  // Only for a host this replica was sent.
  const { servedMonetizedHostIds } = await import("./replica-hosts");
  if (!(await servedMonetizedHostIds(instanceId, now)).has(request.hostId)) return { denied: { allow: false, status: 403, error: "host_not_monetized" } };
  // Only for a key the client presented to the replica.
  const checked = precheckReplicaRequest({ hostId: request.hostId, key: request.key, now });
  if ("allow" in checked) return { denied: checked };
  const consumerId = checked.consumer.id;
  return await withClusterLock(`monetization-lease:${instanceId}`, async (): Promise<AllowanceReply> => {
    const node = request.node;
    const known = await liveNodes(instanceId, now);
    const nodeAllowed = node in known || Object.keys(known).length < MAX_NODES_PER_REPLICA;
    const perConsumer = total(liveBuckets(await outstanding.get(`c:${instanceId}:${node}:${consumerId}`), now));
    const perNode = total(liveBuckets(await outstanding.get(`n:${instanceId}:${node}`), now));
    if (!nodeAllowed || perConsumer >= MAX_UNREPORTED_PER_CONSUMER || perNode >= MAX_UNREPORTED_PER_NODE) {
      return { denied: { allow: false, status: 429, error: "rate_limited", retryAfterSeconds: Math.ceil(LEASE_TTL_MS / 1000), limit: 0 } };
    }
    const reserved = await store.reserve(checked, Math.min(request.want, checked.plan.perMinute ?? MAX_LEASE_REQUESTS, MAX_LEASE_REQUESTS));
    if ("allow" in reserved) return { denied: reserved };
    const id = randomUUID();
    const minute = Math.floor(now / 60_000);
    await leases.put(
      id,
      { instanceId, node, consumerId, granted: reserved.granted, free: reserved.free, priceMicros: checked.plan.priceMicros, month: checked.month, minute },
      LEASE_MEMORY_MS
    );
    await changeOutstanding(`c:${instanceId}:${node}:${consumerId}`, minute, 1, now);
    await changeOutstanding(`n:${instanceId}:${node}`, minute, 1, now);
    await nodeRegistry.put(`r:${instanceId}`, { nodes: { ...known, [node]: minute } }, LEASE_MEMORY_MS);
    return { lease: { id, granted: reserved.granted, free: reserved.free, priceMicros: checked.plan.priceMicros, planId: checked.plan.id, ttlMs: LEASE_TTL_MS } };
  });
}

/** The master's endpoint (app/api/monetization/replica/allowance/route.ts). */
export async function handleAllowanceHttp(request: Request): Promise<Response> {
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
  // The client's address first: nothing is looked up for an address that keeps failing.
  const address = ipRateLimitBucket(getClientIp(request.headers));
  const limited = await addressLimiter.isRateLimited(address);
  if (limited.blocked) {
    return json(429, { error: "rate_limited" }, { "Retry-After": String(limited.retryAfterMs ? Math.ceil(limited.retryAfterMs / 1000) : 60) });
  }
  const { getInstanceMode } = await import("@/src/lib/instance-sync");
  if ((await getInstanceMode()) !== "master") return json(403, { error: "not_master" });
  const replica = await authenticateReplica(request.headers.get("authorization"));
  if (!replica) {
    await addressLimiter.registerAttempt(address);
    return json(401, { error: "unauthorized" });
  }
  if ((await replicaLimiter.registerAttempt(`replica:${replica.instanceId}`)).blocked) return json(429, { error: "rate_limited" });
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > 64 * 1024) return json(413, { error: "too_large" });
    body = JSON.parse(text);
  } catch {
    return json(400, { error: "invalid_request" });
  }
  const parsed = parseAllowanceRequest(body);
  if (!parsed) return json(400, { error: "invalid_request" });
  return json(200, await grantAllowance(replica.instanceId, parsed));
}

// ── Replica: using allowances ────────────────────────────────────────

type LocalLease = { id: string; consumerId: number; planId: number; granted: number; free: number; priceMicros: number; used: number; expiresAt: number };
type Transport = (body: unknown) => Promise<AllowanceReply>;

type ReplicaState = {
  leases: Map<number, LocalLease>;
  /** The request to the master in progress per consumer: its denial, or null when an allowance came. */
  inflight: Map<number, Promise<GateDenial | null>>;
  /** Used-up or expired allowances whose report has not reached the master yet. */
  unreported: LocalLease[];
};

function monotonic(): number {
  return performance.now();
}

/** The transport to the master's gate: HTTPS with the replica's allowance credential, bounded in time. */
export function httpTransport(gateUrl: string, credential: string): Transport {
  return async (body) => {
    const response = await fetch(`${gateUrl}${ALLOWANCE_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`The master's gate answered HTTP ${response.status}`);
    return readAllowanceReply(await response.json());
  };
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * A denial from the master, rebuilt field by field (untrusted input): only
 * the denials the gate itself answers, with values of the right type.
 */
export function readDenial(value: unknown): GateDenial {
  const unavailable: GateDenial = { allow: false, status: 503, error: "unavailable" };
  if (typeof value !== "object" || value === null) return unavailable;
  const d = value as Record<string, unknown>;
  const offer = isCount(d.planId) ? { planId: d.planId, acceptX402: false } : {};
  switch (d.error) {
    case "host_not_monetized":
    case "consumer_disabled":
    case "plan_not_allowed":
    case "no_plan":
      return { allow: false, status: 403, error: d.error };
    case "missing_api_key":
    case "invalid_api_key":
      return {
        allow: false,
        status: 401,
        error: d.error,
        keyHeader: typeof d.keyHeader === "string" && /^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(d.keyHeader) ? d.keyHeader : "Authorization",
        bearer: d.bearer !== false,
      };
    case "rate_limited":
      return {
        allow: false,
        status: 429,
        error: "rate_limited",
        retryAfterSeconds: isCount(d.retryAfterSeconds) ? Math.min(60, Math.max(1, d.retryAfterSeconds)) : 60,
        limit: isCount(d.limit) ? d.limit : 0,
      };
    case "payment_required":
      if (!Number.isSafeInteger(d.balanceMicros) || !isCount(d.priceMicros)) return unavailable;
      return { allow: false, status: 402, error: "payment_required", balanceMicros: d.balanceMicros as number, priceMicros: d.priceMicros, ...offer };
    case "usage_cap_reached":
      if (!isCount(d.openAmountMicros) || !isCount(d.capMicros) || !isCount(d.priceMicros)) return unavailable;
      return { allow: false, status: 402, error: "usage_cap_reached", openAmountMicros: d.openAmountMicros, capMicros: d.capMicros, priceMicros: d.priceMicros, ...offer };
    case "payment_method_required":
      return { allow: false, status: 402, error: "payment_method_required", ...offer };
    case "payment_overdue":
      return {
        allow: false,
        status: 402,
        error: "payment_overdue",
        reason: readSuspensionReason(d.reason),
        ...offer,
      };
    default:
      return unavailable;
  }
}

/** The master's answer, checked (untrusted input); throws when it is not one. */
export function readAllowanceReply(value: unknown): AllowanceReply {
  if (typeof value !== "object" || value === null) throw new Error("Invalid allowance reply");
  const record = value as Record<string, unknown>;
  if (typeof record.lease === "object" && record.lease !== null) {
    const lease = record.lease as Record<string, unknown>;
    const ok =
      typeof lease.id === "string" && /^[0-9a-f-]{36}$/.test(lease.id) &&
      isCount(lease.granted) && isCount(lease.free) && isCount(lease.priceMicros) && isCount(lease.planId) && isCount(lease.ttlMs) &&
      lease.granted >= 1 && lease.granted <= MAX_LEASE_REQUESTS && lease.free <= lease.granted && lease.ttlMs <= LEASE_TTL_MS;
    if (!ok) throw new Error("Invalid allowance reply");
    return {
      lease: {
        id: lease.id as string,
        granted: lease.granted as number,
        free: lease.free as number,
        priceMicros: lease.priceMicros as number,
        planId: lease.planId as number,
        ttlMs: lease.ttlMs as number,
      },
    };
  }
  if (typeof record.denied === "object" && record.denied !== null) return { denied: readDenial(record.denied) };
  if (isCount(record.reported)) return { reported: record.reported };
  throw new Error("Invalid allowance reply");
}

/** Takes one request out of a valid allowance of the consumer, or null. */
function consume(lease: LocalLease | undefined, planId: number, now: number): { free: boolean } | null {
  if (!lease || lease.planId !== planId || now >= lease.expiresAt || lease.used >= lease.granted) return null;
  lease.used += 1;
  return { free: lease.used <= lease.free };
}

function retire(state: ReplicaState, consumerId: number): void {
  const lease = state.leases.get(consumerId);
  if (!lease) return;
  state.leases.delete(consumerId);
  state.unreported.push(lease);
  if (state.unreported.length > 10_000) state.unreported.splice(0, state.unreported.length - 10_000);
}

/** Takes allowances to report (of one consumer first); put them back with `state.unreported.push` when sending fails. */
function takeReports(state: ReplicaState, consumerId?: number): LocalLease[] {
  const mine = consumerId === undefined ? state.unreported : state.unreported.filter((lease) => lease.consumerId === consumerId);
  const picked = mine.slice(0, MAX_REPORTS);
  const ids = new Set(picked.map((lease) => lease.id));
  state.unreported = state.unreported.filter((lease) => !ids.has(lease.id));
  return picked;
}

function asReports(leases: LocalLease[]): AllowanceReport[] {
  return leases.map((lease) => ({ leaseId: lease.id, used: Math.min(lease.used, lease.granted) }));
}

export type AllowanceStore = MonetizationBalanceStore & {
  /** Reports used-up and expired allowances to the master (the replica's background tick). */
  reportExpired(): Promise<number>;
};

/**
 * The balance store of a replica in allowance mode. Decides from the
 * replica's index and its allowances; asks the master for the next
 * allowance when needed (one request at a time per consumer). The
 * allowances live with the store (one per process, replica-store.ts).
 */
export function createAllowanceStore(transport: Transport, local: MonetizationBalanceStore, node: string = randomUUID()): AllowanceStore {
  const state: ReplicaState = { leases: new Map(), inflight: new Map(), unreported: [] };

  async function fetchLease(context: { consumerId: number; key: string; hostId: number; want: number }): Promise<GateDenial | null> {
    retire(state, context.consumerId);
    const reporting = takeReports(state, context.consumerId);
    let reply: AllowanceReply;
    try {
      // The key the client presented: the master charges only keys a replica was actually sent.
      reply = await transport({ v: 1, hostId: context.hostId, key: context.key, want: context.want, node, reports: asReports(reporting) });
    } catch {
      // Reported again with the next request; refused meanwhile, never let through ungated.
      state.unreported.push(...reporting);
      return { allow: false, status: 503, error: "unavailable" };
    }
    if ("denied" in reply) return reply.denied;
    if (!("lease" in reply)) return { allow: false, status: 503, error: "unavailable" };
    state.leases.set(context.consumerId, {
      ...reply.lease,
      consumerId: context.consumerId,
      used: 0,
      expiresAt: monotonic() + reply.lease.ttlMs,
    });
    return null;
  }

  return {
    backend: "redis",
    async decide(request) {
      await ensureMonetizationLoaded();
      const checked = precheckGate(request);
      if ("allow" in checked) return checked;
      const consumerId = checked.consumer.id;
      const hostId = Number(request.hostId);
      const key = presentedKeyOf(request);
      if (!key) return { allow: false, status: 503, error: "unavailable" };
      for (let attempt = 0; attempt < 3; attempt++) {
        const taken = consume(state.leases.get(consumerId), checked.plan.id, monotonic());
        if (taken) {
          const decision: GateDecision = {
            allow: true,
            consumerId,
            planId: checked.plan.id,
            chargedMicros: taken.free ? 0 : checked.plan.priceMicros,
            free: taken.free,
          };
          return decision;
        }
        // One request to the master at a time per consumer; the others wait for its outcome.
        let pending = state.inflight.get(consumerId);
        if (!pending) {
          pending = fetchLease({ consumerId, key, hostId, want: MAX_LEASE_REQUESTS }).finally(() =>
            state.inflight.delete(consumerId)
          );
          state.inflight.set(consumerId, pending);
        }
        const denial = await pending;
        if (denial) return denial;
      }
      return { allow: false, status: 503, error: "unavailable" };
    },
    async credit() {
      throw new Error("A replica does not credit balances; its master does");
    },
    async liveCounters(rows) {
      return local.liveCounters(rows);
    },
    async beforeConsumerDeleted() {},
    async consumerDeleted() {},
    async consumerStatusChanged() {},
    async keyRevoked() {},
    async allowCall(bucket, limit, windowMs) {
      return local.allowCall(bucket, limit, windowMs);
    },
    async creditFailedAnswers() {
      // Not on allowance replicas (see the file comment).
      return null;
    },
    async reserve() {
      throw new Error("A replica does not reserve allowances; its master does");
    },
    async release() {},
    async reportExpired() {
      const now = monotonic();
      for (const [consumerId, lease] of state.leases) if (now >= lease.expiresAt) retire(state, consumerId);
      const reporting = takeReports(state);
      if (reporting.length === 0) return 0;
      try {
        await transport({ v: 1, reportOnly: true, reports: asReports(reporting) });
      } catch {
        state.unreported.push(...reporting);
      }
      return reporting.length;
    },
  };
}

/** Tests only: forget the master's allowance registry. */
export async function resetAllowancesForTests(): Promise<void> {
  await leases.clear();
  await outstanding.clear();
  await nodeRegistry.clear();
  resetAllowanceAuthForTests();
}
