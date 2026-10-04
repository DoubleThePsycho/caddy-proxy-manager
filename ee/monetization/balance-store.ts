// SPDX-License-Identifier: Elastic-2.0
/**
 * Where API monetization balances and usage counters live: one interface,
 * three stores.
 *
 *  - Local (the default): this process's memory, written to SQLite every few
 *    seconds by the engine (engine.ts), exactly as before high availability.
 *  - Shared (ee/high-availability/shared-state/monetization-store.ts), when
 *    high availability shared state is on: Redis or Valkey, charged with one
 *    atomic script per request, so requests on several web nodes never spend
 *    the same money twice. The leader writes usage and credits back to the
 *    ledger (monetization-drain.ts).
 *
 *  - Replica (replica-store.ts), on a sync replica serving monetized hosts:
 *    the master's balances, through its shared state or allowances from its
 *    gate.
 *
 * The gate, top-ups, adjustments, views and the consumer portal call these
 * methods and never branch on the store.
 */
import { monetizationConsumers } from "@/src/lib/db/schema";
import { getSharedMonetizationStore } from "@/ee/high-availability/shared-state/monetization-store";
import {
  allowCall,
  decideGate,
  dropConsumer,
  ensureMonetizationLoaded,
  flushUsage,
  pendingUsage,
  releaseRequests,
  replicaMeta,
  reserveRequests,
  type GateContext,
  type GateDecision,
  type GateDenial,
  type GateRequest,
  type Reservation,
} from "./engine";
import { applyBalanceChange, type BalanceChange, type BalanceChangeResult } from "./ledger";
import { applyAnswerCreditsLocally, type AnswerCreditItem, type AnswerCreditResult } from "./answer-credits";

type ConsumerRow = typeof monetizationConsumers.$inferSelect;

/** A consumer's balance and free requests as the gate sees them. */
export type LiveCounters = { balanceMicros: number; includedRequestsUsed: number };

export interface MonetizationBalanceStore {
  readonly backend: "local" | "redis";
  /** One gate decision; a successful one is charged. */
  decide(request: GateRequest): Promise<GateDecision>;
  /** A top-up or manual adjustment: the balance and the ledger, at most once per reference. */
  credit(change: BalanceChange): Promise<BalanceChangeResult>;
  /** Balances and free requests used this month, including usage not yet in the ledger. */
  liveCounters(rows: ConsumerRow[]): Promise<Map<number, LiveCounters>>;
  /** Before a consumer is deleted: its usage goes to the ledger first. */
  beforeConsumerDeleted(consumerId: number): Promise<void>;
  /** After a consumer was deleted: forget its counters. */
  consumerDeleted(consumerId: number): Promise<void>;
  /** A consumer was disabled or enabled: every node refuses (or accepts) it at once. */
  consumerStatusChanged(consumerId: number, active: boolean): Promise<void>;
  /** A key was revoked: every node refuses it at once. */
  keyRevoked(consumerId: number, keyId: number): Promise<void>;
  /** Fixed-window limit of the consumer and portal endpoints (not the gate). */
  allowCall(bucket: string, limit: number, windowMs: number): Promise<boolean>;
  /**
   * Credits back requests answered with a 5xx (answer-credits.ts), each
   * charge id at most once; null when the consumer is gone.
   */
  creditFailedAnswers(consumerId: number, items: AnswerCreditItem[], now: number): Promise<AnswerCreditResult | null>;
  /**
   * Reserves up to `want` requests at once for a sync replica's allowance,
   * charged as that many gate decisions (replica-allowance.ts).
   */
  reserve(context: GateContext, want: number): Promise<Reservation | GateDenial>;
  /** Gives back reserved requests the replica did not use. */
  release(consumerId: number, month: string, unused: Reservation): Promise<void>;
}

function thisMonth(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7);
}

/** This process's counters and SQLite (no high availability shared state). */
export const localBalanceStore: MonetizationBalanceStore = {
  backend: "local",

  async decide(request) {
    await ensureMonetizationLoaded();
    return decideGate(request);
  },

  async credit(change) {
    return await applyBalanceChange(change);
  },

  async liveCounters(rows) {
    const month = thisMonth();
    const result = new Map<number, LiveCounters>();
    for (const row of rows) {
      const pending = pendingUsage(row.id);
      const stored = row.freeUsageMonth === month ? row.freeUsageCount : 0;
      result.set(row.id, {
        balanceMicros: row.balanceMicros - pending.chargeMicros,
        includedRequestsUsed: pending.freeUsedThisMonth ?? stored,
      });
    }
    return result;
  },

  async beforeConsumerDeleted() {
    await flushUsage();
  },

  async consumerDeleted(consumerId) {
    dropConsumer(consumerId);
  },

  async consumerStatusChanged() {
    // The engine's index (refreshConsumer) is this process's only copy.
  },

  async keyRevoked() {
    // The engine's index (reloadMonetization) is this process's only copy.
  },

  async allowCall(bucket, limit, windowMs) {
    return allowCall(bucket, limit, windowMs);
  },

  async creditFailedAnswers(consumerId, items, now) {
    return await applyAnswerCreditsLocally(consumerId, items, now);
  },

  async reserve(context, want) {
    return reserveRequests(context, want);
  },

  async release(consumerId, month, unused) {
    releaseRequests(consumerId, month, unused);
  },
};

/**
 * The store in effect: shared when high availability shared state is on,
 * local otherwise. Throws when shared state is on but cannot be used, so the
 * gate fails closed instead of counting on one node.
 */
export async function monetizationBalanceStore(): Promise<MonetizationBalanceStore> {
  // A sync replica serving monetized hosts charges its master's balances.
  const replica = replicaMeta();
  if (replica) {
    const { replicaBalanceStore } = await import("./replica-store");
    return await replicaBalanceStore(replica, localBalanceStore);
  }
  return (await getSharedMonetizationStore()) ?? localBalanceStore;
}
