// SPDX-License-Identifier: Elastic-2.0
/**
 * The gate's in-memory state and its per-request decision.
 *
 * Hot path: decideGate() is synchronous and touches no database. It reads an
 * index loaded from the database (key prefix -> key, consumers, plans, monetized
 * hosts, the gate token digest) and keeps per-consumer runtime counters:
 * usage not yet written, the free requests used this month and the
 * per-minute window. One call costs two SHA-256 digests of short strings
 * (gate token and API key), a handful of Map lookups and integer arithmetic.
 *
 * Persistence: flushUsage() writes the pending usage of every consumer that
 * made requests since the last flush, in one transaction: one ledger
 * row per consumer and UTC hour (updated in place), the balance (relative
 * update, so top-ups written meanwhile are kept), the free-request counter
 * and the keys' last use (to the minute). It runs every FLUSH_INTERVAL_MS and when the
 * process is stopped (SIGTERM, SIGINT). A crash or a hard kill loses at most
 * one interval of counts, in the consumers' favour.
 *
 * Changes made by administrators, top-ups and adjustments write the database
 * first and then call reloadMonetization() or refreshConsumer(), which re-read
 * the rows and keep the runtime counters. A reload reads in one read-only
 * transaction and swaps the whole index in at once, so a gate decision never
 * sees half of one; flushes run one at a time, and a reload or refresh that
 * read before a flush wrote balances reads again.
 *
 * With high availability shared state the counters are not kept here: the
 * shared store (balance-store.ts, ee/high-availability/shared-state) uses
 * precheckGate() for the checks that need no counters and charges in Redis or
 * Valkey; the index stays here, reloaded when another node announces a
 * change (onMonetizationIndexChanged).
 *
 * Several web replicas on one PostgreSQL database: each keeps its own index,
 * and an administrator's change on one is announced on the invalidation bus
 * (src/lib/db/events.ts, channel "monetization": "index" or
 * "consumer:<id>"); the others read the index (or the consumer) again, and
 * all of them after their listening connection came back (a resync). Every
 * replica that serves the gate flushes its own counters (the flush timer
 * starts with the first gate decision, not only on the node that runs
 * background jobs). A flush adds to the stored free-request count instead of
 * overwriting it and takes back the stored balance and count, so replicas
 * that count side by side never lose or double each other's usage. Without
 * high availability shared state each replica still checks balances,
 * monthly allowances and per-minute limits against its own counters, so they
 * can overshoot by what the other replicas counted since their last flush:
 * turning monetization on with several replicas requires shared state
 * (assertStandalone in hosts.ts).
 *
 * The state lives on globalThis because Next.js can load this module more
 * than once in the same process (instrumentation and route bundles).
 * Nothing here checks the license.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { eq, isNull, sql } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import {
  monetizationConsumers,
  monetizationHosts,
  monetizationKeys,
  monetizationLedger,
  monetizationPlans,
} from "@/src/lib/db/schema";
import { config } from "@/src/lib/config";
import { keyDigest, keyMatchesDigest, keyPrefix } from "./keys";
import { readCurrency, readGateSecret, readStoredPayments } from "./settings";
import { PORTAL_PATH, readSuspensionReason, type BillingMode, type SuspensionReason } from "./types";
import { chargeIdKey, issueChargeId } from "./charge-id";
import { cardExpiresAt } from "./billing-rules";
import { isAnalyticsEnabled } from "@/src/lib/clickhouse/client";
import { readX402Config, type X402Config } from "./x402/settings";
import { first as dbFirst } from "@/src/lib/db/ops";
import { outsideTransaction } from "@/src/lib/db/executor";
import { isPostgres } from "@/src/lib/db/dialect";
import { countReplicas, publish, subscribe, type BusEvent } from "@/src/lib/db/events";
import { onShutdown } from "@/src/lib/shutdown";

export const FLUSH_INTERVAL_MS = 5_000;
/** API keys' lastUsedAt is written at most once a minute per key. */
const KEY_LAST_USED_RESOLUTION_MS = 60_000;

type HostEntry = {
  /** Lower case, for the lookup. */
  keyHeader: string;
  /** As configured, for messages. */
  keyHeaderName: string;
  bearer: boolean;
  allowedPlanIds: ReadonlySet<number>;
  /** x402 on this host (x402/gate.ts); null when off. */
  x402: HostX402 | null;
};

/** x402 on a host: its price per request in US cents, or null for the x402 settings' price. */
export type HostX402 = { priceCents: number | null };
export type PlanEntry = {
  id: number;
  name: string;
  priceMicros: number;
  includedPerMonth: number;
  perMinute: number | null;
  billing: BillingMode;
  /** Postpaid hard cap; null when the plan has none (postpaid consumers then get no credit at all). */
  capMicros: number | null;
  /** Requests answered with a 5xx are credited back: the gate issues a charge id for each. */
  creditFailed: boolean;
  acceptX402: boolean;
};
type KeyEntry = { id: number; consumerId: number; digest: Buffer };
export type ConsumerEntry = {
  id: number;
  active: boolean;
  planId: number | null;
  /** As stored in SQLite; pending usage is subtracted on top. */
  balance: number;
  overdraft: number;
  freeMonth: string | null;
  freeUsed: number;
  /** The consumer's own billing (null: the plan's). */
  billing: BillingMode | null;
  /** A card is saved (postpaid). */
  hasCard: boolean;
  /** The first moment the saved card no longer works (ms), or null. */
  cardExpiresAt: number | null;
  suspended: SuspensionReason | null;
};
type Runtime = {
  pendingCharge: number;
  pendingRequests: number;
  pendingFree: number;
  freeMonth: string;
  freeUsed: number;
  windowStart: number;
  windowCount: number;
  keyUse: Map<number, number>;
};
type Limiter = { windowStart: number; count: number };

/** On a sync replica serving monetized hosts: how it charges its master's balances (replica-index.ts). */
export type ReplicaMeta = { mode: "shared" | "allowance"; namespace: string | null; gateUrl: string | null };

type EngineState = {
  loaded: boolean;
  /** Set on a sync replica whose master sent a monetization section; null elsewhere. */
  replica: ReplicaMeta | null;
  gateTokenDigest: Buffer | null;
  /** HMAC key of the charge ids (derived from the gate token); null without a gate secret. */
  chargeKey: Buffer | null;
  /** The x402 settings (x402/settings.ts, no secrets); null until loaded. */
  x402: X402Config | null;
  /** Failed-answer credits are on: ClickHouse analytics (the access-log pipeline) is configured. */
  answerCredits: boolean;
  installId: string | null;
  currency: string;
  topUpUrl: string;
  hosts: Map<number, HostEntry>;
  plans: Map<number, PlanEntry>;
  keysByPrefix: Map<string, KeyEntry>;
  consumers: Map<number, ConsumerEntry>;
  runtime: Map<number, Runtime>;
  dirty: Set<number>;
  limiters: Map<string, Limiter>;
  /** When each key's lastUsedAt was last written (written at most once a minute). */
  keyWrittenAt: Map<number, number>;
  month: { key: string; startsAt: number; endsAt: number };
  timer: ReturnType<typeof setInterval> | null;
  exitHook: boolean;
  /** The flush in progress: flushes run one at a time, so usage is never written twice. */
  flushing: Promise<FlushResult> | null;
  /** Counts flushes that wrote balances: a reload that read before one of them reads again. */
  flushes: number;
};

function emptyState(): EngineState {
  return {
    loaded: false,
    replica: null,
    gateTokenDigest: null,
    chargeKey: null,
    x402: null,
    answerCredits: false,
    installId: null,
    currency: "usd",
    topUpUrl: `${config.baseUrl}${PORTAL_PATH}`,
    hosts: new Map(),
    plans: new Map(),
    keysByPrefix: new Map(),
    consumers: new Map(),
    runtime: new Map(),
    dirty: new Set(),
    limiters: new Map(),
    keyWrittenAt: new Map(),
    month: { key: "", startsAt: 0, endsAt: 0 },
    timer: null,
    exitHook: false,
    flushing: null,
    flushes: 0,
  };
}

const store = globalThis as typeof globalThis & { __ingressiMonetization?: EngineState };
function state(): EngineState {
  return (store.__ingressiMonetization ??= emptyState());
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function parseAllowedPlanIds(raw: string): Set<number> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isSafeInteger(id) && id > 0) : []);
  } catch {
    // Unreadable list: allow no plan rather than every plan.
    return new Set([-1]);
  }
}

// ── Loading ──────────────────────────────────────────────────────────

// ── Change notifications ─────────────────────────────────────────────
// With high availability shared state, other web nodes keep their own index:
// ee/high-availability/shared-state/workers.ts listens here and tells them
// to reload.

type IndexListener = () => void;
const listenerStore = globalThis as typeof globalThis & { __ingressiMonetizationListeners?: Set<IndexListener> };

/** Called after an administrator's change reloaded the index (not after a reload another node asked for). */
export function onMonetizationIndexChanged(listener: IndexListener): () => void {
  const listeners = (listenerStore.__ingressiMonetizationListeners ??= new Set());
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The invalidation bus channel of the gate's index (payload "index" or "consumer:<id>"). */
export const MONETIZATION_CHANNEL = "monetization";

/**
 * Tells the other replicas in the background (src/lib/db/events.ts), from
 * code that cannot wait; never throws, never joins the caller's transaction.
 */
function announceInBackground(payload: string): void {
  void outsideTransaction(() => publish(MONETIZATION_CHANNEL, payload));
}

/** Sends the change to sync replicas serving monetized hosts (debounced; replica-sync.ts). */
function announceToReplicas(): void {
  void import("./replica-sync").then((module) => module.announceReplicaIndexChange()).catch(() => undefined);
}

/** Whether a consumer changed in what a replica's index holds (not its balance). */
function replicaRelevantChange(before: ConsumerEntry | undefined, after: ConsumerEntry): boolean {
  if (!before) return true;
  return (
    before.active !== after.active ||
    before.planId !== after.planId ||
    before.overdraft !== after.overdraft ||
    before.billing !== after.billing ||
    before.hasCard !== after.hasCard ||
    before.cardExpiresAt !== after.cardExpiresAt ||
    before.suspended !== after.suspended
  );
}

async function notifyIndexChanged(payload = "index"): Promise<void> {
  if (payload === "index") announceToReplicas();
  for (const listener of listenerStore.__ingressiMonetizationListeners ?? []) {
    try {
      listener();
    } catch {
      // A listener never breaks a change.
    }
  }
  // Inside a transaction the other replicas hear of it when it commits.
  await publish(MONETIZATION_CHANNEL, payload);
}

/** What another replica's announcement does here: read the index, or one consumer, again. */
async function onIndexEvent(event: BusEvent): Promise<void> {
  // Nothing loaded here yet: the first gate decision reads everything.
  if (!state().loaded) return;
  if (event.kind === "message") {
    if (event.self) return;
    const consumer = /^consumer:([1-9]\d{0,9})$/.exec(event.payload ?? "");
    if (consumer) {
      await refreshConsumer(Number(consumer[1]), { quiet: true });
      return;
    }
  }
  await reloadMonetization({ quiet: true });
}

// One subscription per process, whichever copy of this module loads first.
const busStore = globalThis as typeof globalThis & { __ingressiMonetizationBus?: boolean };
if (!busStore.__ingressiMonetizationBus) {
  busStore.__ingressiMonetizationBus = true;
  subscribe(MONETIZATION_CHANNEL, (event) => onIndexEvent(event));
}

/** The consumer columns the gate's index reads. */
const CONSUMER_INDEX_COLUMNS = {
  id: monetizationConsumers.id,
  status: monetizationConsumers.status,
  planId: monetizationConsumers.planId,
  balance: monetizationConsumers.balanceMicros,
  overdraft: monetizationConsumers.overdraftAllowanceMicros,
  freeMonth: monetizationConsumers.freeUsageMonth,
  freeUsed: monetizationConsumers.freeUsageCount,
  billing: monetizationConsumers.billing,
  paymentMethodId: monetizationConsumers.paymentMethodId,
  cardExpMonth: monetizationConsumers.cardExpMonth,
  cardExpYear: monetizationConsumers.cardExpYear,
  suspendedReason: monetizationConsumers.suspendedReason,
  suspendedAt: monetizationConsumers.suspendedAt,
};

type ConsumerIndexRow = {
  id: number;
  status: string;
  planId: number | null;
  balance: number;
  overdraft: number;
  freeMonth: string | null;
  freeUsed: number;
  billing: string | null;
  paymentMethodId: string | null;
  cardExpMonth: number | null;
  cardExpYear: number | null;
  suspendedReason: string | null;
  suspendedAt: string | null;
};

function readBilling(value: string | null | undefined): BillingMode | null {
  return value === "prepaid" || value === "postpaid" ? value : null;
}

function readSuspension(row: Pick<ConsumerIndexRow, "suspendedAt" | "suspendedReason">): SuspensionReason | null {
  if (!row.suspendedAt) return null;
  return readSuspensionReason(row.suspendedReason);
}

export function toConsumerEntry(row: ConsumerIndexRow): ConsumerEntry {
  return {
    id: row.id,
    active: row.status === "active",
    planId: row.planId,
    balance: row.balance,
    overdraft: Math.max(0, row.overdraft),
    freeMonth: row.freeMonth,
    freeUsed: row.freeUsed,
    billing: readBilling(row.billing),
    hasCard: Boolean(row.paymentMethodId),
    cardExpiresAt: cardExpiresAt(row.cardExpMonth, row.cardExpYear),
    suspended: readSuspension(row),
  };
}

type PlanIndexRow = typeof monetizationPlans.$inferSelect;

export function toPlanEntry(row: PlanIndexRow): PlanEntry {
  return {
    id: row.id,
    name: row.name,
    priceMicros: Math.max(0, row.pricePerRequestMicros),
    includedPerMonth: Math.max(0, row.includedRequestsPerMonth),
    perMinute: row.requestsPerMinute && row.requestsPerMinute > 0 ? row.requestsPerMinute : null,
    billing: readBilling(row.billing) ?? "prepaid",
    capMicros: row.postpaidCapMicros !== null && row.postpaidCapMicros > 0 ? row.postpaidCapMicros : null,
    creditFailed: row.creditFailedAnswers === true,
    acceptX402: row.acceptX402 === true,
  };
}

/** The rows the gate's index is built from. */
async function readIndexRows() {
  const plans = await appDb.select().from(monetizationPlans);
  const consumers = await appDb.select(CONSUMER_INDEX_COLUMNS).from(monetizationConsumers);
  const keys = await appDb
    .select({ id: monetizationKeys.id, consumerId: monetizationKeys.consumerId, prefix: monetizationKeys.prefix, hash: monetizationKeys.keyHash })
    .from(monetizationKeys)
    .where(isNull(monetizationKeys.revokedAt));
  const hosts = await appDb.select().from(monetizationHosts).where(eq(monetizationHosts.enabled, true));
  const gate = await readGateSecret();
  const payments = await readStoredPayments();
  const currency = await readCurrency(payments);
  const x402 = await readX402Config();
  return { plans, consumers, keys, hosts, gate, payments, currency, x402 };
}

type IndexMaps = {
  plans: Map<number, PlanEntry>;
  consumers: Map<number, ConsumerEntry>;
  keys: Array<{ id: number; consumerId: number; prefix: string; hash: string }>;
  hosts: Array<{ proxyHostId: number; keyHeader: string; allowedPlanIds: ReadonlySet<number>; x402: HostX402 | null }>;
  currency: string;
  topUpUrl: string;
  replica: ReplicaMeta | null;
  /** Replicas offer no x402: null there. */
  x402: X402Config | null;
};

/** The index from this instance's database (a master, or standalone). */
async function loadIndexFromDatabase(s: EngineState): Promise<IndexMaps & { gate: Awaited<ReturnType<typeof readGateSecret>> }> {
  // The rows in one read-only transaction (a consistent snapshot). A flush
  // that wrote balances while they were read makes the reload read again,
  // so the index never takes a balance from before a flush the runtime
  // counters already account for.
  let snapshot: Awaited<ReturnType<typeof readIndexRows>>;
  for (let attempt = 0; ; attempt++) {
    const flushes = s.flushes;
    snapshot = await appDb.transaction(async () => await readIndexRows(), { readOnly: true });
    if (flushes === s.flushes || attempt >= 4) break;
  }
  const { plans, consumers, keys, hosts, gate, payments, currency, x402 } = snapshot;
  return {
    plans: new Map(plans.map((row) => [row.id, toPlanEntry(row)])),
    consumers: new Map(consumers.map((row) => [row.id, toConsumerEntry(row)])),
    keys,
    hosts: hosts.map((row) => ({
      proxyHostId: row.proxyHostId,
      keyHeader: row.keyHeader,
      allowedPlanIds: parseAllowedPlanIds(row.allowedPlanIds),
      x402: row.x402Enabled
        ? {
            priceCents: row.x402PriceCents !== null && row.x402PriceCents > 0 ? row.x402PriceCents : null,
          }
        : null,
    })),
    currency,
    topUpUrl: typeof payments.topUpUrl === "string" && payments.topUpUrl ? payments.topUpUrl : `${config.baseUrl}${PORTAL_PATH}`,
    replica: null,
    x402,
    gate,
  };
}

/**
 * The index on a sync replica: from the section its master sent
 * (replica-sync.ts), without balances (they are the master's). Without a
 * section the index is empty and the replica gates nothing.
 */
async function loadIndexFromReplica(): Promise<IndexMaps & { gate: Awaited<ReturnType<typeof readGateSecret>> }> {
  const { readReplicaSection } = await import("./replica-sync");
  const section = await readReplicaSection();
  const gate = await readGateSecret();
  if (!section) {
    return { plans: new Map(), consumers: new Map(), keys: [], hosts: [], currency: "usd", topUpUrl: `${config.baseUrl}${PORTAL_PATH}`, replica: null, x402: null, gate };
  }
  const plans = new Map<number, PlanEntry>(
    section.plans.map((plan) => [
      plan.id,
      { id: plan.id, name: plan.name, priceMicros: plan.priceMicros, includedPerMonth: plan.includedPerMonth, perMinute: plan.perMinute, billing: plan.billing, capMicros: plan.capMicros && plan.capMicros > 0 ? plan.capMicros : null, creditFailed: plan.creditFailed, acceptX402: false },
    ])
  );
  const consumers = new Map<number, ConsumerEntry>(
    section.consumers.map((consumer) => [
      consumer.id,
      {
        id: consumer.id,
        active: consumer.active,
        planId: consumer.planId,
        // The master's balance is charged, never this one.
        balance: 0,
        overdraft: consumer.overdraftMicros,
        freeMonth: null,
        freeUsed: 0,
        billing: consumer.billing,
        hasCard: consumer.hasCard,
        cardExpiresAt: cardExpiresAt(consumer.cardExpMonth, consumer.cardExpYear),
        suspended: consumer.suspended === null ? null : readSuspensionReason(consumer.suspended),
      },
    ])
  );
  return {
    plans,
    consumers,
    keys: section.keys,
    hosts: section.hosts.map((host) => ({ proxyHostId: host.proxyHostId, keyHeader: host.keyHeader, allowedPlanIds: new Set(host.allowedPlanIds), x402: null })),
    currency: section.currency,
    topUpUrl: section.topUpUrl,
    replica: { mode: section.mode, namespace: section.namespace, gateUrl: section.gateUrl },
    x402: null,
    gate,
  };
}

async function isSyncReplica(): Promise<boolean> {
  const { getInstanceMode } = await import("@/src/lib/instance-sync");
  return (await getInstanceMode()) === "slave";
}

export async function reloadMonetization(options: { quiet?: boolean } = {}): Promise<void> {
  const s = state();
  const index = (await isSyncReplica()) ? await loadIndexFromReplica() : await loadIndexFromDatabase(s);
  const { gate } = index;

  const keyMap = new Map<string, KeyEntry>();
  for (const row of index.keys) {
    if (!index.consumers.has(row.consumerId)) continue;
    const entry = { id: row.id, consumerId: row.consumerId, digest: keyDigest(row.hash) };
    keyMap.set(row.prefix, entry);
  }
  const hostMap = new Map<number, HostEntry>();
  for (const row of index.hosts) {
    const keyHeader = row.keyHeader.toLowerCase();
    hostMap.set(row.proxyHostId, { keyHeader, keyHeaderName: row.keyHeader, bearer: keyHeader === "authorization", allowedPlanIds: row.allowedPlanIds, x402: row.x402 });
  }
  for (const id of [...s.runtime.keys()]) {
    if (!index.consumers.has(id) && !s.dirty.has(id)) s.runtime.delete(id);
  }

  s.plans = index.plans;
  s.consumers = index.consumers;
  s.keysByPrefix = keyMap;
  s.hosts = hostMap;
  s.replica = index.replica;
  s.x402 = index.x402;
  s.gateTokenDigest = gate ? digest(gate.token) : null;
  s.chargeKey = gate ? chargeIdKey(gate.token) : null;
  s.answerCredits = isAnalyticsEnabled();
  s.installId = gate?.installId ?? null;
  s.currency = index.currency;
  s.topUpUrl = index.topUpUrl;
  s.loaded = true;
  if (!options.quiet) await notifyIndexChanged();
}

/** How this sync replica charges its master's balances; null on a master or standalone, or before the first load. */
export function replicaMeta(): ReplicaMeta | null {
  return state().replica;
}

/** Loads the state on first use (the first gate call after a start that skipped instrumentation). */
export async function ensureMonetizationLoaded(): Promise<void> {
  if (!state().loaded) await reloadMonetization({ quiet: true });
  // Every replica that serves the gate writes what it counted.
  if (process.env.NODE_ENV !== "test") startMetering();
}

async function readConsumerRow(consumerId: number) {
  return await dbFirst(appDb
    .select(CONSUMER_INDEX_COLUMNS)
    .from(monetizationConsumers)
    .where(eq(monetizationConsumers.id, consumerId))
    .limit(1));
}

/** Re-reads one consumer after its balance, status, plan or allowance changed. */
export async function refreshConsumer(consumerId: number, options: { quiet?: boolean } = {}): Promise<void> {
  const s = state();
  // A replica has no consumer rows of its own: its index comes from the master.
  if (!s.loaded || s.replica) return await reloadMonetization(options);
  // Read again when a flush wrote balances meanwhile (see reloadMonetization).
  let row: Awaited<ReturnType<typeof readConsumerRow>>;
  for (let attempt = 0; ; attempt++) {
    const flushes = s.flushes;
    row = await readConsumerRow(consumerId);
    if (flushes === s.flushes || attempt >= 4) break;
  }
  if (!row) {
    s.consumers.delete(consumerId);
    for (const [prefix, key] of s.keysByPrefix) if (key.consumerId === consumerId) s.keysByPrefix.delete(prefix);
    if (!options.quiet) {
      announceToReplicas();
      await notifyIndexChanged(`consumer:${consumerId}`);
    }
    return;
  }
  const entry = toConsumerEntry(row);
  const before = s.consumers.get(row.id);
  s.consumers.set(row.id, entry);
  if (!options.quiet) {
    if (replicaRelevantChange(before, entry)) announceToReplicas();
    await notifyIndexChanged(`consumer:${consumerId}`);
  }
}

// ── Gate decision ────────────────────────────────────────────────────

export type GateRequest = {
  gateToken: string | null;
  hostId: string | null;
  /** Case-insensitive request header lookup. */
  header: (name: string) => string | null;
  now?: number;
};

/** Who a 402 is for: the consumer and its plan, for the x402 offer of plans that accept it. */
type PaymentDenialContext = { planId?: number; acceptX402?: boolean; consumerId?: number };

export type GateDenial =
  | { allow: false; status: 403; error: "forbidden" | "host_not_monetized" | "consumer_disabled" | "plan_not_allowed" | "no_plan" }
  | ({ allow: false; status: 401; error: "missing_api_key" | "invalid_api_key"; keyHeader: string; bearer: boolean })
  | { allow: false; status: 429; error: "rate_limited"; retryAfterSeconds: number; limit: number }
  /** Prepaid: the balance does not cover the price (beyond the overdraft allowance). */
  | ({ allow: false; status: 402; error: "payment_required"; balanceMicros: number; priceMicros: number } & PaymentDenialContext)
  /** Postpaid: the unpaid usage would pass the plan's cap. */
  | ({ allow: false; status: 402; error: "usage_cap_reached"; openAmountMicros: number; capMicros: number; priceMicros: number } & PaymentDenialContext)
  /** Postpaid without a usable saved card. */
  | ({ allow: false; status: 402; error: "payment_method_required" } & PaymentDenialContext)
  /** Postpaid and suspended: a charge failed, needs the card holder, or the payment is disputed. */
  | ({ allow: false; status: 402; error: "payment_overdue"; reason: SuspensionReason } & PaymentDenialContext)
  /** Shared balances (high availability) or the master's gate could not be reached: the request is refused, never let through uncharged. */
  | { allow: false; status: 503; error: "unavailable" };

export type GateDecision =
  | {
      allow: true;
      consumerId: number;
      planId: number;
      chargedMicros: number;
      free: boolean;
      /** Set on plans that credit failed answers: Caddy logs it with the answer's status (answer-credits.ts). */
      chargeId?: string;
    }
  | GateDenial;

/** "YYYY-MM" (UTC) of `now`, cached until the month changes. */
function currentMonth(s: EngineState, now: number): string {
  if (now >= s.month.endsAt || now < s.month.startsAt) {
    const date = new Date(now);
    s.month = {
      key: date.toISOString().slice(0, 7),
      startsAt: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
      endsAt: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
    };
  }
  return s.month.key;
}

function runtimeFor(s: EngineState, consumer: ConsumerEntry, month: string): Runtime {
  let runtime = s.runtime.get(consumer.id);
  if (!runtime) {
    runtime = {
      pendingCharge: 0,
      pendingRequests: 0,
      pendingFree: 0,
      freeMonth: consumer.freeMonth ?? month,
      freeUsed: consumer.freeMonth === month ? consumer.freeUsed : 0,
      windowStart: 0,
      windowCount: 0,
      keyUse: new Map(),
    };
    s.runtime.set(consumer.id, runtime);
  }
  if (runtime.freeMonth !== month) {
    runtime.freeMonth = month;
    runtime.freeUsed = 0;
  }
  return runtime;
}

function validGateToken(s: EngineState, supplied: string | null): boolean {
  if (!s.gateTokenDigest || !supplied) return false;
  return timingSafeEqual(digest(supplied), s.gateTokenDigest);
}

function presentedKey(host: HostEntry, header: GateRequest["header"]): string | null {
  const value = header(host.keyHeader);
  if (!value) return null;
  if (host.bearer) {
    const match = /^Bearer[ \t]+([^\s]+)[ \t]*$/i.exec(value);
    return match ? match[1] : null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

/** What a request that passed the checks below is charged against. */
export type GateContext = {
  consumer: ConsumerEntry;
  plan: PlanEntry;
  keyId: number;
  /** The host's key header, for a 401 answer. */
  keyHeader: string;
  bearer: boolean;
  now: number;
  /** "YYYY-MM" (UTC) of now. */
  month: string;
  /** Postpaid in effect (the consumer's billing, or the plan's). */
  postpaid: boolean;
  /** How far below zero the balance may go: the overdraft allowance (prepaid) or the plan's cap (postpaid). */
  limitMicros: number;
};

/** The 402 for a request the balance (prepaid) or the cap (postpaid) does not cover. */
export function insufficientDecision(context: Pick<GateContext, "postpaid" | "limitMicros" | "plan" | "consumer">, balanceMicros: number): GateDenial {
  const offer = { planId: context.plan.id, acceptX402: context.plan.acceptX402, consumerId: context.consumer.id };
  if (context.postpaid) {
    return {
      allow: false,
      status: 402,
      error: "usage_cap_reached",
      openAmountMicros: Math.max(0, -balanceMicros),
      capMicros: context.limitMicros,
      priceMicros: context.plan.priceMicros,
      ...offer,
    };
  }
  return { allow: false, status: 402, error: "payment_required", balanceMicros, priceMicros: context.plan.priceMicros, ...offer };
}

/** A charge id for a successful decision on a plan that credits failed answers, or undefined. */
export function chargeIdFor(plan: PlanEntry, consumerId: number, chargedMicros: number, free: boolean, now: number): string | undefined {
  const s = state();
  if (!plan.creditFailed || !s.answerCredits || !s.chargeKey) return undefined;
  return issueChargeId(s.chargeKey, { consumerId, chargedMicros, free, issuedAtMs: now });
}

function rateLimited(plan: PlanEntry, now: number): GateDenial {
  const window = Math.floor(now / 60_000) * 60_000;
  return {
    allow: false,
    status: 429,
    error: "rate_limited",
    retryAfterSeconds: Math.max(1, Math.ceil((window + 60_000 - now) / 1000)),
    limit: plan.perMinute ?? 0,
  };
}

export function rateLimitedDecision(context: Pick<GateContext, "plan" | "now">): GateDenial {
  return rateLimited(context.plan, context.now);
}

/**
 * The checks of a gate request that need no counters: gate token, host, key,
 * consumer, plan. Synchronous, no I/O. Returns the denial, or what the
 * request is to be charged against.
 */
export function precheckGate(request: GateRequest): GateDenial | GateContext {
  const s = state();
  if (!validGateToken(s, request.gateToken)) return { allow: false, status: 403, error: "forbidden" };

  const hostId = request.hostId && /^[1-9]\d{0,9}$/.test(request.hostId) ? Number(request.hostId) : null;
  const host = hostId === null ? undefined : s.hosts.get(hostId);
  if (!host) return { allow: false, status: 403, error: "host_not_monetized" };

  const raw = presentedKey(host, request.header);
  if (!raw) return { allow: false, status: 401, error: "missing_api_key", keyHeader: host.keyHeaderName, bearer: host.bearer };
  const prefix = raw.length <= 128 ? keyPrefix(raw) : null;
  const key = prefix ? s.keysByPrefix.get(prefix) : undefined;
  if (!key || !keyMatchesDigest(raw, key.digest)) return { allow: false, status: 401, error: "invalid_api_key", keyHeader: host.keyHeaderName, bearer: host.bearer };

  return checkConsumer(s, host, key, request.now ?? Date.now());
}

/**
 * The master's check of a replica's allowance request (replica-allowance.ts):
 * the replica forwards the API key the client presented, and the master
 * checks it against its own index exactly as its gate would (prefix, then the
 * digest in constant time). A replica can therefore only reserve requests
 * for keys it was actually sent, never charge a consumer by naming its id.
 */
export function precheckReplicaRequest(input: { hostId: number; key: string; now: number }): GateDenial | GateContext {
  const s = state();
  const host = s.hosts.get(input.hostId);
  if (!host) return { allow: false, status: 403, error: "host_not_monetized" };
  const prefix = input.key.length <= 128 ? keyPrefix(input.key) : null;
  const key = prefix ? s.keysByPrefix.get(prefix) : undefined;
  if (!key || !keyMatchesDigest(input.key, key.digest)) {
    return { allow: false, status: 401, error: "invalid_api_key", keyHeader: host.keyHeaderName, bearer: host.bearer };
  }
  return checkConsumer(s, host, key, input.now);
}

/** The API key a request presents for its host (as the gate reads it), or null. */
export function presentedKeyOf(request: Pick<GateRequest, "hostId" | "header">): string | null {
  const s = state();
  const hostId = request.hostId && /^[1-9]\d{0,9}$/.test(request.hostId) ? Number(request.hostId) : null;
  const host = hostId === null ? undefined : s.hosts.get(hostId);
  return host ? presentedKey(host, request.header) : null;
}

function checkConsumer(s: EngineState, host: HostEntry, key: KeyEntry, now: number): GateDenial | GateContext {
  const consumer = s.consumers.get(key.consumerId);
  if (!consumer) return { allow: false, status: 401, error: "invalid_api_key", keyHeader: host.keyHeaderName, bearer: host.bearer };
  if (!consumer.active) return { allow: false, status: 403, error: "consumer_disabled" };
  const plan = consumer.planId === null ? undefined : s.plans.get(consumer.planId);
  if (!plan) return { allow: false, status: 403, error: "no_plan" };
  if (host.allowedPlanIds.size > 0 && !host.allowedPlanIds.has(plan.id)) {
    return { allow: false, status: 403, error: "plan_not_allowed" };
  }

  const postpaid = (consumer.billing ?? plan.billing) === "postpaid";
  if (postpaid) {
    const offer = { planId: plan.id, acceptX402: plan.acceptX402, consumerId: consumer.id };
    if (consumer.suspended) return { allow: false, status: 402, error: "payment_overdue", reason: consumer.suspended, ...offer };
    if (!consumer.hasCard || (consumer.cardExpiresAt !== null && now >= consumer.cardExpiresAt)) {
      return { allow: false, status: 402, error: "payment_method_required", ...offer };
    }
  }
  return {
    consumer,
    plan,
    keyId: key.id,
    keyHeader: host.keyHeaderName,
    bearer: host.bearer,
    now,
    month: currentMonth(s, now),
    postpaid,
    // A postpaid consumer of a plan without a cap gets no credit: strictly prepaid.
    limitMicros: postpaid ? plan.capMicros ?? 0 : consumer.overdraft,
  };
}

/**
 * One gate decision with this process's counters (no high availability
 * shared state). Synchronous, no I/O. On success the request is charged in
 * memory (free monthly requests first, then the price per request).
 */
export function decideGate(request: GateRequest): GateDecision {
  const s = state();
  const checked = precheckGate(request);
  if ("allow" in checked) return checked;
  const { consumer, plan, now } = checked;
  const key = { id: checked.keyId };
  const runtime = runtimeFor(s, consumer, checked.month);

  if (plan.perMinute !== null) {
    const window = Math.floor(now / 60_000) * 60_000;
    if (runtime.windowStart !== window) {
      runtime.windowStart = window;
      runtime.windowCount = 0;
    }
    if (runtime.windowCount >= plan.perMinute) return rateLimited(plan, now);
  }

  let charged = 0;
  const free = runtime.freeUsed < plan.includedPerMonth;
  if (!free) {
    const balance = consumer.balance - runtime.pendingCharge;
    if (balance - plan.priceMicros < -checked.limitMicros) return insufficientDecision(checked, balance);
    charged = plan.priceMicros;
  }

  if (free) {
    runtime.freeUsed += 1;
    runtime.pendingFree += 1;
  }
  runtime.pendingCharge += charged;
  runtime.pendingRequests += 1;
  runtime.windowCount += 1;
  runtime.keyUse.set(key.id, now);
  s.dirty.add(consumer.id);
  const chargeId = chargeIdFor(plan, consumer.id, charged, free, now);
  return { allow: true, consumerId: consumer.id, planId: plan.id, chargedMicros: charged, free, ...(chargeId ? { chargeId } : {}) };
}

/** Requests reserved at once for a replica's allowance (replica-allowance.ts). */
export type Reservation = { granted: number; free: number; chargedMicros: number };

/**
 * Reserves up to `want` requests for a replica's allowance with this
 * process's counters, exactly as `want` gate decisions would charge them:
 * the per-minute window, free requests first, then the price while the
 * balance stays within the limit. Fewer when fewer fit; a denial when none
 * does. Synchronous, no I/O.
 */
export function reserveRequests(context: GateContext, want: number): Reservation | GateDenial {
  const s = state();
  const { consumer, plan, now } = context;
  const runtime = runtimeFor(s, consumer, context.month);
  let n = Math.max(1, Math.trunc(want));
  if (plan.perMinute !== null) {
    const window = Math.floor(now / 60_000) * 60_000;
    if (runtime.windowStart !== window) {
      runtime.windowStart = window;
      runtime.windowCount = 0;
    }
    const left = plan.perMinute - runtime.windowCount;
    if (left <= 0) return rateLimited(plan, now);
    n = Math.min(n, left);
  }
  const free = Math.min(n, Math.max(0, plan.includedPerMonth - runtime.freeUsed));
  let charged = n - free;
  const balance = consumer.balance - runtime.pendingCharge;
  if (charged > 0 && plan.priceMicros > 0) {
    charged = Math.min(charged, Math.max(0, Math.floor((balance + context.limitMicros) / plan.priceMicros)));
  }
  const granted = free + charged;
  if (granted === 0) return insufficientDecision(context, balance);
  const chargedMicros = charged * plan.priceMicros;
  runtime.freeUsed += free;
  runtime.pendingFree += free;
  runtime.pendingCharge += chargedMicros;
  runtime.pendingRequests += granted;
  runtime.windowCount += granted;
  runtime.keyUse.set(context.keyId, now);
  s.dirty.add(consumer.id);
  return { granted, free, chargedMicros };
}

/**
 * Gives back requests of a reservation the replica did not use: the next
 * flush takes them off the hour's usage and puts the money back on the
 * balance (the pending counts go below zero until then). A reservation of
 * an earlier month (a report that came after the month changed) gives back
 * its requests and money, but not its free requests: they stay counted in
 * the month that is over, and the current month's free requests (and the
 * stored count the flush writes from them) are never touched.
 */
export function releaseRequests(consumerId: number, month: string, unused: Reservation): void {
  const s = state();
  if (unused.granted <= 0 && unused.chargedMicros <= 0) return;
  const consumer = s.consumers.get(consumerId);
  // Never runtimeFor(month): an earlier month would reset this month's free count.
  const runtime = s.runtime.get(consumerId) ?? (consumer ? runtimeFor(s, consumer, currentMonth(s, Date.now())) : undefined);
  if (!runtime) return;
  runtime.pendingRequests -= unused.granted;
  runtime.pendingCharge -= unused.chargedMicros;
  if (runtime.freeMonth === month) {
    runtime.pendingFree -= unused.free;
    runtime.freeUsed = Math.max(0, runtime.freeUsed - unused.free);
  }
  s.dirty.add(consumerId);
}

/**
 * Takes back free requests of `month` credited to a consumer (failed
 * answers): this process's count of the month's free requests, which the
 * next flush reconciles with the stored one.
 */
export function returnFreeRequests(consumerId: number, month: string, count: number): void {
  const runtime = state().runtime.get(consumerId);
  if (!runtime || count <= 0 || runtime.freeMonth !== month) return;
  runtime.freeUsed = Math.max(0, runtime.freeUsed - count);
}

// ── Persistence ──────────────────────────────────────────────────────

export type FlushResult = { consumers: number; requests: number; chargedMicros: number };

/** Writes pending usage to SQLite in one transaction; on failure everything stays pending. */
export async function flushUsage(now: number = Date.now()): Promise<FlushResult> {
  const s = state();
  // One flush at a time (the timer, a shutdown signal and a consumer change can
  // overlap): a second one waits for the first, then writes what is still pending.
  const previous = s.flushing;
  const current = (async () => {
    if (previous) await previous.catch(() => undefined);
    return writePendingUsage(now);
  })();
  s.flushing = current;
  try {
    return await current;
  } finally {
    if (s.flushing === current) s.flushing = null;
  }
}

/** Writes the usage counted since the last flush; requests counted meanwhile stay pending. */
async function writePendingUsage(now: number): Promise<FlushResult> {
  const s = state();
  const result: FlushResult = { consumers: 0, requests: 0, chargedMicros: 0 };
  if (s.dirty.size === 0) return result;

  const stamp = new Date(now).toISOString();
  const hour = stamp.slice(0, 13);
  const work = [...s.dirty].flatMap((consumerId) => {
    const runtime = s.runtime.get(consumerId);
    if (!runtime) return [];
    return [{
      consumerId,
      runtime,
      charge: runtime.pendingCharge,
      requests: runtime.pendingRequests,
      free: runtime.pendingFree,
      freeMonth: runtime.freeMonth,
      freeUsed: runtime.freeUsed,
      keyUse: [...runtime.keyUse],
    }];
  });
  const balances = new Map<number, { balance: number; freeMonth: string | null; freeUsed: number }>();
  const keysWritten: Array<[number, number]> = [];

  await appDb.transaction(async (tx) => {
    for (const item of work) {
      // Below zero after a replica gave back reserved requests it did not use.
      if (item.requests !== 0 || item.charge !== 0) {
        // Relative updates: other replicas may have written this consumer's
        // usage since this one read it. The free requests of the month are
        // added to the stored count (this replica's count replaces it only
        // in a new month).
        const updated = (await dbFirst(tx
          .update(monetizationConsumers)
          .set({
            balanceMicros: sql`${monetizationConsumers.balanceMicros} - ${item.charge}`,
            freeUsageMonth: item.freeMonth,
            freeUsageCount: sql`CASE WHEN ${monetizationConsumers.freeUsageMonth} = ${item.freeMonth} THEN ${monetizationConsumers.freeUsageCount} + ${item.free} ELSE ${item.freeUsed} END`,
          })
          .where(eq(monetizationConsumers.id, item.consumerId))
          .returning({
            balance: monetizationConsumers.balanceMicros,
            freeMonth: monetizationConsumers.freeUsageMonth,
            freeUsed: monetizationConsumers.freeUsageCount,
          })))!;
        if (!updated) continue;
        balances.set(item.consumerId, updated);
        await tx.insert(monetizationLedger)
          .values({
            consumerId: item.consumerId,
            type: "usage",
            amountMicros: -item.charge,
            balanceAfterMicros: updated.balance,
            requests: item.requests,
            freeRequests: item.free,
            externalReference: `usage:${item.consumerId}:${hour}`,
            createdAt: stamp,
            updatedAt: stamp,
          })
          .onConflictDoUpdate({
            target: monetizationLedger.externalReference,
            set: {
              amountMicros: sql`${monetizationLedger.amountMicros} - ${item.charge}`,
              balanceAfterMicros: updated.balance,
              requests: sql`${monetizationLedger.requests} + ${item.requests}`,
              freeRequests: sql`${monetizationLedger.freeRequests} + ${item.free}`,
              updatedAt: stamp,
            },
          });
      }
      for (const [keyId, at] of item.keyUse) {
        if (at - (s.keyWrittenAt.get(keyId) ?? 0) < KEY_LAST_USED_RESOLUTION_MS) continue;
        await tx.update(monetizationKeys).set({ lastUsedAt: new Date(at).toISOString() }).where(eq(monetizationKeys.id, keyId));
        keysWritten.push([keyId, at]);
      }
    }
  });

  if (balances.size > 0) s.flushes += 1;
  for (const [keyId, at] of keysWritten) s.keyWrittenAt.set(keyId, at);
  for (const item of work) {
    item.runtime.pendingCharge -= item.charge;
    item.runtime.pendingRequests -= item.requests;
    item.runtime.pendingFree -= item.free;
    // Requests the gate counted while the flush was writing stay pending.
    for (const [keyId, at] of item.keyUse) if (item.runtime.keyUse.get(keyId) === at) item.runtime.keyUse.delete(keyId);
    if (item.runtime.pendingRequests === 0 && item.runtime.pendingCharge === 0 && item.runtime.pendingFree === 0 && item.runtime.keyUse.size === 0) {
      s.dirty.delete(item.consumerId);
    }
    const stored = balances.get(item.consumerId);
    const consumer = s.consumers.get(item.consumerId);
    if (stored && consumer) {
      consumer.balance = stored.balance;
      consumer.freeMonth = stored.freeMonth;
      consumer.freeUsed = stored.freeUsed;
    }
    // What every replica has written for the month, plus what this one
    // counted since the flush began (the same number with one replica).
    if (stored && stored.freeMonth === item.runtime.freeMonth) item.runtime.freeUsed = stored.freeUsed + item.runtime.pendingFree;
    if (!stored && item.requests !== 0) {
      // The consumer was deleted: its counts have nowhere to go.
      s.runtime.delete(item.consumerId);
    }
    result.consumers += 1;
    result.requests += item.requests;
    result.chargedMicros += item.charge;
  }
  return result;
}

/** Forgets a deleted consumer (flush its usage first to keep it in the ledger); the other replicas forget it too. */
export function dropConsumer(consumerId: number): void {
  const s = state();
  s.runtime.delete(consumerId);
  s.dirty.delete(consumerId);
  s.consumers.delete(consumerId);
  for (const [prefix, key] of s.keysByPrefix) if (key.consumerId === consumerId) s.keysByPrefix.delete(prefix);
  announceInBackground(`consumer:${consumerId}`);
}

// ── Reads for views and consumer endpoints ───────────────────────────

/** Usage of a consumer not written to SQLite yet, and its free requests this month. */
export function pendingUsage(consumerId: number, now: number = Date.now()): {
  chargeMicros: number;
  requests: number;
  freeUsedThisMonth: number | null;
} {
  const s = state();
  const runtime = s.runtime.get(consumerId);
  if (!runtime) return { chargeMicros: 0, requests: 0, freeUsedThisMonth: null };
  const month = new Date(now).toISOString().slice(0, 7);
  return {
    chargeMicros: runtime.pendingCharge,
    requests: runtime.pendingRequests,
    freeUsedThisMonth: runtime.freeMonth === month ? runtime.freeUsed : 0,
  };
}

/** The consumer behind a well-formed, unrevoked key; no database access. */
export async function authenticateConsumerKey(raw: string): Promise<{ consumerId: number; keyId: number } | null> {
  await ensureMonetizationLoaded();
  const s = state();
  const prefix = raw.length <= 128 ? keyPrefix(raw) : null;
  const key = prefix ? s.keysByPrefix.get(prefix) : undefined;
  if (!key || !keyMatchesDigest(raw, key.digest) || !s.consumers.has(key.consumerId)) return null;
  return { consumerId: key.consumerId, keyId: key.id };
}

/** Fixed-window limiter for the consumer and portal endpoints (not the gate). */
export function allowCall(bucket: string, limit: number, windowMs: number, now: number = Date.now()): boolean {
  const s = state();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const entry = s.limiters.get(bucket);
  if (!entry || entry.windowStart !== windowStart) {
    if (s.limiters.size > 10_000) s.limiters.clear();
    s.limiters.set(bucket, { windowStart, count: 1 });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

/** What x402 needs about a request's host: its x402 settings and the install's. */
export function x402Context(hostId: number): { host: HostX402; config: X402Config } | null {
  const s = state();
  const host = s.hosts.get(hostId)?.x402;
  if (!host || !s.x402 || s.replica) return null;
  return { host, config: s.x402 };
}

/** The HMAC key of charge ids (failed-answer credits); null before the gate secret is loaded. */
export function currentChargeKey(): Buffer | null {
  return state().chargeKey;
}

export function gateContext(): { currency: string; topUpUrl: string; installId: string | null } {
  const s = state();
  return { currency: s.currency, topUpUrl: s.topUpUrl, installId: s.installId };
}

// ── Lifecycle ────────────────────────────────────────────────────────

/** Never rejects: a failure is logged and the usage stays pending for the next flush. */
async function safeFlush(): Promise<void> {
  try {
    const result = await flushUsage();
    if (result.requests > 0 && process.env.MONETIZATION_DEBUG === "1") {
      console.log(`[monetization] Flushed ${result.requests} request(s) of ${result.consumers} consumer(s)`);
    }
  } catch (error) {
    console.error("[monetization] Writing usage failed; it stays pending:", error instanceof Error ? error.name : typeof error);
  }
}

/** How often a replica that keeps its own counters checks whether others share the database. */
const REPLICA_CHECK_MS = 60_000;
const REPLICA_WARNING_MS = 10 * 60_000;
const replicaCheck = globalThis as typeof globalThis & { __ingressiMonetizationReplicaCheck?: { checkedAt: number; warnedAt: number } };

/**
 * On PostgreSQL, with monetized hosts and this process's counters (no high
 * availability shared state): logs when other replicas use the database too,
 * since each then counts on its own (see the module comment). Never throws.
 */
async function warnAboutReplicas(now: number = Date.now()): Promise<void> {
  const check = (replicaCheck.__ingressiMonetizationReplicaCheck ??= { checkedAt: 0, warnedAt: 0 });
  if (!isPostgres() || state().hosts.size === 0 || now - check.checkedAt < REPLICA_CHECK_MS) return;
  check.checkedAt = now;
  try {
    const { isSharedStateOn } = await import("@/ee/high-availability/shared-state/connection");
    if (await isSharedStateOn()) return;
    const replicas = await countReplicas();
    if (replicas > 1 && now - check.warnedAt >= REPLICA_WARNING_MS) {
      check.warnedAt = now;
      console.warn(
        `[monetization] ${replicas} web replicas use this database but API balances are counted by each replica on its own: ` +
          "turn on high availability shared state, or run one replica, so limits and balances hold across replicas"
      );
    }
  } catch {
    // Checked again later.
  }
}

/**
 * Flushes usage every FLUSH_INTERVAL_MS and when the process stops
 * (idempotent). Started with the engine, and by the first gate decision on a
 * replica that did not start it.
 *
 * The writes are asynchronous, so they cannot run in an `exit` hook: the last
 * flush starts on SIGTERM or SIGINT (and on `beforeExit`) and the process
 * waits for it before exiting (src/lib/shutdown.ts). A process killed
 * outright (SIGKILL, a crash) loses at most the usage counted in the last
 * FLUSH_INTERVAL_MS (5 seconds).
 */
function startMetering(): void {
  const s = state();
  if (!s.timer) {
    s.timer = setInterval(() => {
      void safeFlush();
      void warnAboutReplicas();
    }, FLUSH_INTERVAL_MS);
    s.timer.unref?.();
  }
  if (!s.exitHook) {
    s.exitHook = true;
    const flushOnShutdown = async (): Promise<void> => {
      await safeFlush();
    };
    // SIGTERM and SIGINT: the process waits for the flush (src/lib/shutdown.ts).
    onShutdown("writing API monetization usage", flushOnShutdown);
    process.once("beforeExit", () => void flushOnShutdown());
  }
}

/** Loads the state and starts metering. Started from src/instrumentation.ts. */
export async function startMonetizationEngine(): Promise<void> {
  await reloadMonetization({ quiet: true });
  startMetering();
}

export async function stopMonetizationEngine(): Promise<void> {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
  await safeFlush();
}

/** Tests only: forget everything. */
export function resetMonetizationEngineForTests(): void {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  store.__ingressiMonetization = emptyState();
}

/**
 * Keeps the gate in step when the Caddy configuration had to (re)create the
 * gate secret; the other replicas read it again (their gate would refuse
 * Caddy's new token otherwise).
 */
export function adoptGateSecret(secret: { token: string; installId: string }): void {
  const s = state();
  const next = digest(secret.token);
  const changed = !s.gateTokenDigest || !timingSafeEqual(next, s.gateTokenDigest) || s.installId !== secret.installId;
  s.gateTokenDigest = next;
  s.chargeKey = chargeIdKey(secret.token);
  s.installId = secret.installId;
  if (changed && s.loaded) announceInBackground("index");
}
