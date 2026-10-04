// SPDX-License-Identifier: Elastic-2.0
/**
 * API monetization balances and usage counters in Redis or Valkey (high
 * availability shared state), behind the interface of
 * ee/monetization/balance-store.ts.
 *
 * Keys of one consumer share the hash tag {mz:<id>} (one cluster slot):
 *   c          hash: ep epoch, bal balance, fm/fu free month and requests
 *              used, ws/wc per-minute window, tc/tr/tf cumulative charged
 *              micro-units, requests and free requests since the epoch,
 *              dis disabled, rk:<keyId> revoked keys, k:<keyId> last use (ms)
 *   cr         queue (list) of credits (top-ups, adjustments) not yet in the
 *              ledger, each a JSON entry with its own id
 *   ref:<sha>  a credit reference already applied (SHA-256 of it)
 * and under {mz}: dirty (consumers to drain), version (configuration
 * changes), drain (last drain), drain-lock, rl:<bucket>:<window> (portal
 * rate limits). Every key has a TTL; a consumer's keys are refreshed on use.
 *
 * Nothing secret is stored: no API keys or their hashes (the gate checks
 * those in its own index), only amounts, counts and ledger descriptions that
 * are in clear in SQLite too.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { monetizationConsumers, monetizationSharedCursors } from "@/src/lib/db/schema";
import type { LiveCounters, MonetizationBalanceStore } from "@/ee/monetization/balance-store";
import {
  chargeIdFor,
  dropConsumer,
  ensureMonetizationLoaded,
  insufficientDecision,
  precheckGate,
  rateLimitedDecision,
  type GateContext,
  type GateDecision,
} from "@/ee/monetization/engine";
import { ledgerEntryById, ledgerEntryByReference } from "@/ee/monetization/ledger";
import { getSharedState, type SharedState } from "./connection";
import { isSharedStateLeader } from "./leader";
import { drainSharedMonetization, type SharedCreditEntry } from "./monetization-drain";
import { monetizationKeyNames, MZ_DIRTY_TTL_MS, MZ_REFERENCE_TTL_MS, MZ_STATE_TTL_MS, MZ_VERSION_TTL_MS } from "./monetization-keys";
import { MZ_ANSWER_CREDIT, MZ_CHARGE, MZ_CREDIT, MZ_FLAG, MZ_RELEASE, MZ_RESERVE, MZ_SEED, RATE_WINDOW, runScript } from "./scripts";
import { ANSWER_CREDIT_DESCRIPTION, MAX_CHARGE_AGE_MS, answerCreditReference } from "@/ee/monetization/answer-credits";
import { first } from "@/src/lib/db/ops";

// ── Consumers touched since the last report ─────────────────────────
// The gate notes which consumers it charged; workers.ts adds them to the
// shared dirty set every few seconds, so the leader drains only those (and
// sweeps every consumer now and then, in case a node stopped first).

const dirtyStore = globalThis as typeof globalThis & { __ingressiSharedDirty?: Set<number> };
function touched(): Set<number> {
  return (dirtyStore.__ingressiSharedDirty ??= new Set());
}

/** Takes the consumers charged here since the last call. */
export function takeTouchedConsumers(): number[] {
  const set = touched();
  const ids = [...set];
  set.clear();
  return ids;
}

type Seed = { balance: string; freeMonth: string; freeUsed: string; disabled: string; epoch: string };

function newEpoch(): string {
  return randomBytes(6).toString("hex");
}

/** The values a missing hash starts from: the consumer's row in this node's database. */
async function readSeed(consumerId: number, fallback?: GateContext["consumer"]): Promise<Seed | null> {
  const row = await first(appDb
    .select({
      balance: monetizationConsumers.balanceMicros,
      freeMonth: monetizationConsumers.freeUsageMonth,
      freeUsed: monetizationConsumers.freeUsageCount,
      status: monetizationConsumers.status,
    })
    .from(monetizationConsumers)
    .where(eq(monetizationConsumers.id, consumerId))
    .limit(1));
  if (row) {
    return {
      balance: String(Math.trunc(row.balance)),
      freeMonth: row.freeMonth ?? "",
      freeUsed: String(Math.max(0, Math.trunc(row.freeUsed))),
      disabled: row.status === "active" ? "0" : "1",
      epoch: newEpoch(),
    };
  }
  if (!fallback) return null;
  return {
    balance: String(Math.trunc(fallback.balance)),
    freeMonth: fallback.freeMonth ?? "",
    freeUsed: String(Math.max(0, Math.trunc(fallback.freeUsed))),
    disabled: fallback.active ? "0" : "1",
    epoch: newEpoch(),
  };
}

function seedArgs(seed: Seed | null): string[] {
  return seed ? [seed.balance, seed.freeMonth, seed.freeUsed, seed.disabled, seed.epoch] : ["", "", "", "", ""];
}

function replyList(reply: unknown): string[] {
  return Array.isArray(reply) ? reply.map((item) => (item === null || item === undefined ? "" : String(item))) : [];
}

function safeBucket(bucket: string): string {
  return bucket.replace(/[^A-Za-z0-9:_-]/g, "_").slice(0, 100);
}

/**
 * The store over the shared state. `replica`: a sync replica charging its
 * master's balances (ee/monetization/replica-store.ts): it has no consumer
 * rows, so it never seeds a missing consumer (the master's leader does) and
 * refuses the request (503) instead; it writes nothing to a ledger.
 */
export function createRedisMonetizationStore(state: SharedState, options: { replica?: boolean } = {}): MonetizationBalanceStore {
  const { redis } = state;
  const keys = monetizationKeyNames(state.namespace);
  const replica = options.replica === true;

  async function charge(context: GateContext, seed: Seed | null): Promise<string[]> {
    const { consumer, plan, now } = context;
    return replyList(
      await runScript(redis, MZ_CHARGE, [keys.consumer(consumer.id)], [
        ...seedArgs(seed),
        now,
        Math.floor(now / 60_000) * 60_000,
        context.month,
        plan.perMinute ?? 0,
        plan.includedPerMonth,
        plan.priceMicros,
        context.limitMicros,
        context.keyId,
        MZ_STATE_TTL_MS,
      ])
    );
  }

  async function flag(consumerId: number, operation: "disable" | "enable" | "revoke", keyId = 0): Promise<void> {
    const seed = await readSeed(consumerId);
    if (!seed) return;
    await runScript(redis, MZ_FLAG, [keys.consumer(consumerId)], [...seedArgs(seed), operation, keyId, MZ_STATE_TTL_MS]);
  }

  return {
    backend: "redis",

    async decide(request) {
      await ensureMonetizationLoaded();
      const checked = precheckGate(request);
      if ("allow" in checked) return checked;
      const { consumer, plan } = checked;
      let reply: string[];
      try {
        reply = await charge(checked, null);
        if (reply[0] === "seed") {
          // A replica's index has no balances to seed from.
          if (replica) return { allow: false, status: 503, error: "unavailable" };
          reply = await charge(checked, await readSeed(consumer.id, consumer));
        }
      } catch {
        return { allow: false, status: 503, error: "unavailable" };
      }
      switch (reply[0]) {
        case "ok": {
          touched().add(consumer.id);
          const chargedMicros = Number(reply[1]);
          const free = reply[2] === "1";
          const chargeId = chargeIdFor(plan, consumer.id, chargedMicros, free, checked.now);
          const decision: GateDecision = {
            allow: true,
            consumerId: consumer.id,
            planId: plan.id,
            chargedMicros,
            free,
            ...(chargeId ? { chargeId } : {}),
          };
          return decision;
        }
        case "payment_required":
          return insufficientDecision(checked, Number(reply[1]));
        case "rate_limited":
          return rateLimitedDecision(checked);
        case "disabled":
          return { allow: false, status: 403, error: "consumer_disabled" };
        case "revoked":
          return { allow: false, status: 401, error: "invalid_api_key", keyHeader: checked.keyHeader, bearer: checked.bearer };
        default:
          return { allow: false, status: 503, error: "unavailable" };
      }
    },

    async credit(change) {
      if (replica) throw new Error("A replica does not credit balances; its master does");
      const seed = await readSeed(change.consumerId);
      if (!seed) return { status: "unknown_consumer" };
      // A reference already in the ledger (also from before shared state) is a duplicate.
      if (change.reference && await ledgerEntryByReference(change.reference)) return { status: "duplicate" };
      const entry: SharedCreditEntry = {
        id: randomUUID(),
        ref: change.reference,
        type: change.type,
        amount: change.amountMicros,
        desc: change.description,
        by: change.createdBy,
        at: nowIso(),
      };
      const reply = replyList(
        await runScript(
          redis,
          MZ_CREDIT,
          [
            keys.consumer(change.consumerId),
            keys.credits(change.consumerId),
            // Without a reference the call is unique: nothing to recognise a retry by.
            keys.reference(change.consumerId, change.reference ?? `once:${entry.id}`),
          ],
          [...seedArgs(seed), change.amountMicros, JSON.stringify(entry), MZ_REFERENCE_TTL_MS, MZ_STATE_TTL_MS]
        )
      );
      if (reply[0] === "duplicate") return { status: "duplicate" };
      if (reply[0] !== "applied") throw new Error("Unexpected reply to a shared credit");
      const balanceMicros = Number(reply[1]);
      await redis.sadd(keys.dirty, String(change.consumerId)).then(() => redis.pexpire(keys.dirty, MZ_DIRTY_TTL_MS)).catch(() => 0);
      // The leader writes it to the ledger at once, so the answer can show the entry.
      let ledgerEntry = null;
      if (await isSharedStateLeader()) {
        try {
          const drained = await drainSharedMonetization(state, { consumerIds: [change.consumerId] });
          const ledgerId = drained.credited.get(entry.id);
          ledgerEntry = ledgerId ? await ledgerEntryById(ledgerId) : null;
        } catch {
          // The periodic drain writes it.
        }
      }
      return { status: "applied", entry: ledgerEntry, balanceMicros };
    },

    async liveCounters(rows) {
      const month = new Date().toISOString().slice(0, 7);
      const values = await Promise.all(rows.map((row) => redis.hmget(keys.consumer(row.id), "bal", "fm", "fu")));
      const result = new Map<number, LiveCounters>();
      rows.forEach((row, index) => {
        const [balance, freeMonth, freeUsed] = values[index];
        if (balance === null || balance === undefined) {
          result.set(row.id, {
            balanceMicros: row.balanceMicros,
            includedRequestsUsed: row.freeUsageMonth === month ? row.freeUsageCount : 0,
          });
        } else {
          result.set(row.id, { balanceMicros: Number(balance), includedRequestsUsed: freeMonth === month ? Number(freeUsed ?? 0) : 0 });
        }
      });
      return result;
    },

    async beforeConsumerDeleted(consumerId) {
      // The deletion is refused when the usage cannot be written first.
      await drainSharedMonetization(state, { consumerIds: [consumerId] });
    },

    async consumerDeleted(consumerId) {
      dropConsumer(consumerId);
      await appDb.delete(monetizationSharedCursors).where(eq(monetizationSharedCursors.consumerId, consumerId));
      await redis.del(keys.consumer(consumerId), keys.credits(consumerId)).catch(() => 0);
    },

    consumerStatusChanged: (consumerId, active) => flag(consumerId, active ? "enable" : "disable"),
    keyRevoked: (consumerId, keyId) => flag(consumerId, "revoke", keyId),

    async creditFailedAnswers(consumerId, items, now) {
      if (items.length === 0) return { requests: 0, amountMicros: 0, freeRequests: 0 };
      const month = new Date(now).toISOString().slice(0, 7);
      const perRequest = items.flatMap((item) => [
        createHash("sha256").update(item.chargeId).digest("hex").slice(0, 32),
        String(Math.max(0, Math.trunc(item.amountMicros))),
        item.free ? "1" : "0",
        item.sameMonth ? "1" : "0",
      ]);
      const run = async (seed: Seed | null) =>
        replyList(
          await runScript(redis, MZ_ANSWER_CREDIT, [keys.consumer(consumerId), keys.credits(consumerId)], [
            ...seedArgs(seed),
            month,
            MAX_CHARGE_AGE_MS + 24 * 60 * 60 * 1000,
            MZ_STATE_TTL_MS,
            randomUUID(),
            answerCreditReference(consumerId, now),
            ANSWER_CREDIT_DESCRIPTION,
            new Date(now).toISOString(),
            ...perRequest,
          ])
        );
      let reply = await run(null);
      if (reply[0] === "seed") {
        const seed = await readSeed(consumerId);
        if (!seed) return null;
        reply = await run(seed);
      }
      const requests = Number(reply[1]);
      if (!Number.isSafeInteger(requests)) throw new Error("Unexpected reply to a shared answer credit");
      if (requests > 0) {
        await redis.sadd(keys.dirty, String(consumerId)).then(() => redis.pexpire(keys.dirty, MZ_DIRTY_TTL_MS)).catch(() => 0);
      }
      return { amountMicros: Number(reply[0]), requests, freeRequests: Number(reply[2]) };
    },

    async reserve(context, want) {
      const { consumer, plan, now } = context;
      const run = async (seed: Seed | null) =>
        replyList(
          await runScript(redis, MZ_RESERVE, [keys.consumer(consumer.id)], [
            ...seedArgs(seed),
            now,
            Math.floor(now / 60_000) * 60_000,
            context.month,
            plan.perMinute ?? 0,
            plan.includedPerMonth,
            plan.priceMicros,
            context.limitMicros,
            context.keyId,
            MZ_STATE_TTL_MS,
            Math.max(1, Math.trunc(want)),
          ])
        );
      let reply = await run(null);
      if (reply[0] === "seed") reply = await run(await readSeed(consumer.id));
      switch (reply[0]) {
        case "ok":
          touched().add(consumer.id);
          return { granted: Number(reply[1]), free: Number(reply[2]), chargedMicros: Number(reply[3]) };
        case "payment_required":
          return insufficientDecision(context, Number(reply[1]));
        case "rate_limited":
          return rateLimitedDecision(context);
        case "disabled":
          return { allow: false, status: 403, error: "consumer_disabled" };
        case "revoked":
          return { allow: false, status: 401, error: "invalid_api_key", keyHeader: context.keyHeader, bearer: context.bearer };
        default:
          return { allow: false, status: 503, error: "unavailable" };
      }
    },

    async release(consumerId, month, unused) {
      if (unused.granted <= 0 && unused.chargedMicros <= 0) return;
      const run = async (seed: Seed | null) =>
        replyList(
          await runScript(redis, MZ_RELEASE, [keys.consumer(consumerId)], [
            ...seedArgs(seed),
            month,
            Math.max(0, unused.granted),
            Math.max(0, unused.free),
            Math.max(0, unused.chargedMicros),
            MZ_STATE_TTL_MS,
          ])
        );
      const reply = await run(null);
      if (reply[0] === "seed") {
        const seed = await readSeed(consumerId);
        if (seed) await run(seed);
      }
      touched().add(consumerId);
    },

    async allowCall(bucket, limit, windowMs) {
      const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
      try {
        return Number(await runScript(redis, RATE_WINDOW, [keys.rate(safeBucket(bucket), windowStart)], [limit, windowMs])) === 1;
      } catch {
        return false;
      }
    },
  };
}

/** The shared store when high availability shared state is on, null otherwise. */
export async function getSharedMonetizationStore(): Promise<MonetizationBalanceStore | null> {
  const state = await getSharedState();
  return state ? createRedisMonetizationStore(state) : null;
}

/**
 * Makes sure every consumer has its hash in the shared state, seeded from the
 * leader's database: sync replicas charging these balances never seed one
 * (replica-store.ts). Idempotent; a hash that exists is only kept alive.
 */
export async function seedSharedConsumers(state: SharedState, consumerIds: number[]): Promise<number> {
  const keys = monetizationKeyNames(state.namespace);
  let seeded = 0;
  for (const consumerId of consumerIds) {
    const seed = await readSeed(consumerId);
    if (!seed) continue;
    await runScript(state.redis, MZ_SEED, [keys.consumer(consumerId)], [...seedArgs(seed), MZ_STATE_TTL_MS]);
    seeded += 1;
  }
  return seeded;
}

/** Tells the other nodes to reload the gate's index (plans, consumers, keys, hosts changed). */
export async function publishMonetizationChange(state: SharedState): Promise<void> {
  const { version } = monetizationKeyNames(state.namespace);
  await state.redis.incr(version);
  await state.redis.pexpire(version, MZ_VERSION_TTL_MS);
}
