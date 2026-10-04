// SPDX-License-Identifier: Elastic-2.0
/**
 * The leader writes shared API monetization state back to its database, so
 * the ledger stays the record that reports, the overview and invoices read.
 *
 * Per consumer, in one database transaction:
 *  - usage: the shared hash keeps cumulative counters since its epoch
 *    (charged micro-units, requests, free requests). The cursor row
 *    (monetization_shared_cursors) holds how much of them is already in the
 *    ledger; the difference goes into the hour's usage row and comes off the
 *    stored balance. A new epoch (the hash was created again) starts the
 *    cursor at zero.
 *  - credits: the consumer's credit queue holds top-ups and adjustments, each
 *    with its own id. An id not yet in monetization_shared_credits becomes a
 *    ledger row (one whose reference is already in the ledger is skipped)
 *    and goes onto the balance.
 *  - the keys' last use, at most once a minute per key, as before.
 * The cursor and the credit ids are written in the same transaction as the
 * rows they account for, so a drain repeated after a crash, or run twice,
 * writes nothing twice. Drained credits leave the queue after the commit
 * (by value, so a second drainer never removes what it did not write).
 *
 * A lock in the shared state (drain-lock) keeps two nodes from draining at
 * once; the cursor makes it safe even if they did.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import {
  monetizationConsumers,
  monetizationKeys,
  monetizationLedger,
  monetizationSharedCredits,
  monetizationSharedCursors,
} from "@/src/lib/db/schema";
import type { SharedState } from "./connection";
import { monetizationKeyNames, MZ_DIRTY_TTL_MS } from "./monetization-keys";
import { RELEASE_LOCK, runScript } from "./scripts";
import type { SharedStateDrainStatus } from "./types";
import { first } from "@/src/lib/db/ops";
import { parseRowId } from "@/src/lib/row-ids";

/**
 * A queued top-up, adjustment or failed-answer credit, as JSON in the
 * consumer's credit queue. Credits ("credit") add to the ledger row of their
 * reference (one per consumer and hour) instead of writing a row each.
 */
export type SharedCreditEntry = {
  id: string;
  ref: string | null;
  type: "topup" | "adjustment" | "credit" | "payment" | "refund" | "dispute";
  amount: number;
  desc: string | null;
  by: number | null;
  at: string;
  /** Credits: the requests credited back, and how many of them were free. */
  requests?: number;
  free?: number;
};

const CREDIT_TYPES: ReadonlySet<string> = new Set(["topup", "adjustment", "credit", "payment", "refund", "dispute"]);

const LOCK_TTL_MS = 30_000;
const STATUS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Keys' lastUsedAt is written at most once a minute per key (as without shared state). */
const KEY_LAST_USED_RESOLUTION_MS = 60_000;
/** Credits read per consumer and drain. */
const CREDIT_BATCH = 500;

export type DrainResult = {
  /** Consumers with something written. */
  consumers: number;
  requests: number;
  chargedMicros: number;
  credits: number;
  /** Credit id -> its ledger row id, for each credit written. */
  credited: Map<string, number>;
  /** False when another node held the drain lock (nothing was done). */
  ran: boolean;
};

function fieldsOf(reply: unknown): Record<string, string> {
  const fields: Record<string, string> = {};
  if (Array.isArray(reply)) {
    for (let index = 0; index + 1 < reply.length; index += 2) fields[String(reply[index])] = String(reply[index + 1]);
  } else if (reply && typeof reply === "object") {
    for (const [key, value] of Object.entries(reply)) fields[key] = String(value);
  }
  return fields;
}

function count(value: string | undefined): number {
  return value && /^-?\d{1,16}$/.test(value) ? Number(value) : 0;
}

/** A queued credit, or null for anything that is not one (it is dropped from the queue). */
export function parseCreditEntry(raw: string): SharedCreditEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(entry.id)) return null;
  if (typeof entry.type !== "string" || !CREDIT_TYPES.has(entry.type)) return null;
  const type = entry.type as SharedCreditEntry["type"];
  if (typeof entry.amount !== "number" || !Number.isSafeInteger(entry.amount)) return null;
  const requests = typeof entry.requests === "number" && Number.isSafeInteger(entry.requests) && entry.requests > 0 ? entry.requests : 0;
  // A credit of free requests only moves no money; every other entry does.
  if (entry.amount === 0 && !(type === "credit" && requests > 0)) return null;
  if (type === "credit" && (typeof entry.ref !== "string" || !entry.ref)) return null;
  return {
    id: entry.id,
    ref: typeof entry.ref === "string" && entry.ref ? entry.ref.slice(0, 300) : null,
    type,
    amount: entry.amount,
    ...(type === "credit"
      ? { requests, free: typeof entry.free === "number" && Number.isSafeInteger(entry.free) && entry.free > 0 ? Math.min(entry.free, requests) : 0 }
      : {}),
    desc: typeof entry.desc === "string" && entry.desc ? entry.desc.slice(0, 1000) : null,
    by: typeof entry.by === "number" && Number.isSafeInteger(entry.by) ? entry.by : null,
    at: typeof entry.at === "string" && !Number.isNaN(Date.parse(entry.at)) ? entry.at : new Date().toISOString(),
  };
}

type ConsumerDrain = { requests: number; chargedMicros: number; credits: Array<{ id: string; ledgerId: number }> };

async function drainConsumer(consumerId: number, hash: Record<string, string>, queued: SharedCreditEntry[], now: Date): Promise<ConsumerDrain | null> {
  const stamp = now.toISOString();
  const hour = stamp.slice(0, 13);
  return await appDb.transaction(async (tx): Promise<ConsumerDrain | null> => {
    const consumer = await first(tx
      .select({ id: monetizationConsumers.id })
      .from(monetizationConsumers)
      .where(eq(monetizationConsumers.id, consumerId))
      .limit(1));
    if (!consumer) return null;
    const cursor = await first(tx.select().from(monetizationSharedCursors).where(eq(monetizationSharedCursors.consumerId, consumerId)).limit(1));
    const epoch = hash.ep || cursor?.epoch || "";
    const sameEpoch = cursor !== undefined && cursor.epoch === epoch;
    const base = sameEpoch ? cursor : { chargedMicros: 0, requests: 0, freeRequests: 0 };
    const totals = hash.ep
      ? { charged: count(hash.tc), requests: count(hash.tr), free: count(hash.tf) }
      : { charged: base.chargedMicros, requests: base.requests, free: base.freeRequests };
    // Negative when requests reserved for a replica's allowance were given
    // back unused (ee/monetization/replica-allowance.ts): the hour's usage
    // row and the balance take them back.
    const delta = {
      charged: totals.charged - base.chargedMicros,
      requests: totals.requests - base.requests,
      free: totals.free - base.freeRequests,
    };
    const result: ConsumerDrain = { requests: 0, chargedMicros: 0, credits: [] };

    if (delta.requests !== 0 || delta.charged !== 0) {
      const updated = (await first(tx
        .update(monetizationConsumers)
        .set({
          balanceMicros: sql`${monetizationConsumers.balanceMicros} - ${delta.charged}`,
          ...(hash.fm ? { freeUsageMonth: hash.fm, freeUsageCount: count(hash.fu) } : {}),
        })
        .where(eq(monetizationConsumers.id, consumerId))
        .returning({ balance: monetizationConsumers.balanceMicros })))!;
      await tx.insert(monetizationLedger)
        .values({
          consumerId,
          type: "usage",
          amountMicros: -delta.charged,
          balanceAfterMicros: updated.balance,
          requests: delta.requests,
          freeRequests: delta.free,
          externalReference: `usage:${consumerId}:${hour}`,
          createdAt: stamp,
          updatedAt: stamp,
        })
        .onConflictDoUpdate({
          target: monetizationLedger.externalReference,
          set: {
            amountMicros: sql`${monetizationLedger.amountMicros} - ${delta.charged}`,
            balanceAfterMicros: updated.balance,
            requests: sql`${monetizationLedger.requests} + ${delta.requests}`,
            freeRequests: sql`${monetizationLedger.freeRequests} + ${delta.free}`,
            updatedAt: stamp,
          },
        });
      result.requests = Math.max(0, delta.requests);
      result.chargedMicros = Math.max(0, delta.charged);
    }

    for (const entry of queued) {
      const claimed = (await first(tx
        .insert(monetizationSharedCredits)
        .values({ creditId: entry.id, consumerId, ledgerId: null, createdAt: stamp })
        .onConflictDoNothing({ target: monetizationSharedCredits.creditId })
        .returning({ creditId: monetizationSharedCredits.creditId })))!;
      // Already written by an earlier drain.
      if (!claimed) continue;
      if (entry.type === "credit") {
        // Failed-answer credits of one consumer and hour share a ledger row.
        const updated = (await first(tx
          .update(monetizationConsumers)
          .set({ balanceMicros: sql`${monetizationConsumers.balanceMicros} + ${entry.amount}` })
          .where(eq(monetizationConsumers.id, consumerId))
          .returning({ balance: monetizationConsumers.balanceMicros })))!;
        const row = (await first(tx
          .insert(monetizationLedger)
          .values({
            consumerId,
            type: "credit",
            amountMicros: entry.amount,
            balanceAfterMicros: updated.balance,
            requests: entry.requests ?? 0,
            freeRequests: entry.free ?? 0,
            externalReference: entry.ref,
            description: entry.desc,
            createdAt: entry.at,
            updatedAt: stamp,
          })
          .onConflictDoUpdate({
            target: monetizationLedger.externalReference,
            set: {
              amountMicros: sql`${monetizationLedger.amountMicros} + ${entry.amount}`,
              balanceAfterMicros: updated.balance,
              requests: sql`${monetizationLedger.requests} + ${entry.requests ?? 0}`,
              freeRequests: sql`${monetizationLedger.freeRequests} + ${entry.free ?? 0}`,
              updatedAt: stamp,
            },
          })
          .returning({ id: monetizationLedger.id })))!;
        await tx.update(monetizationSharedCredits).set({ ledgerId: row.id }).where(eq(monetizationSharedCredits.creditId, entry.id));
        result.credits.push({ id: entry.id, ledgerId: row.id });
        continue;
      }
      const inserted = (await first(tx
        .insert(monetizationLedger)
        .values({
          consumerId,
          type: entry.type,
          amountMicros: entry.amount,
          balanceAfterMicros: 0,
          externalReference: entry.ref,
          description: entry.desc,
          createdBy: entry.by,
          createdAt: entry.at,
          updatedAt: stamp,
        })
        .onConflictDoNothing({ target: monetizationLedger.externalReference })
        .returning({ id: monetizationLedger.id })))!;
      if (!inserted) continue;
      const updated = (await first(tx
        .update(monetizationConsumers)
        .set({ balanceMicros: sql`${monetizationConsumers.balanceMicros} + ${entry.amount}` })
        .where(eq(monetizationConsumers.id, consumerId))
        .returning({ balance: monetizationConsumers.balanceMicros })))!;
      await tx.update(monetizationLedger).set({ balanceAfterMicros: updated.balance }).where(eq(monetizationLedger.id, inserted.id));
      await tx.update(monetizationSharedCredits).set({ ledgerId: inserted.id }).where(eq(monetizationSharedCredits.creditId, entry.id));
      result.credits.push({ id: entry.id, ledgerId: inserted.id });
    }

    // Keys' last use, from the k:<keyId> fields, at most once a minute.
    const keyUse = Object.entries(hash)
      .filter(([field, value]) => /^k:\d{1,15}$/.test(field) && parseRowId(field.slice(2)) !== null && /^\d{1,15}$/.test(value))
      .map(([field, value]) => ({ keyId: Number(field.slice(2)), at: Number(value) }));
    if (keyUse.length > 0) {
      const stored = new Map(
        (await tx
          .select({ id: monetizationKeys.id, lastUsedAt: monetizationKeys.lastUsedAt })
          .from(monetizationKeys)
          .where(and(eq(monetizationKeys.consumerId, consumerId), inArray(monetizationKeys.id, keyUse.map((use) => use.keyId)))))
          .map((row) => [row.id, row.lastUsedAt ? Date.parse(row.lastUsedAt) : 0])
      );
      for (const use of keyUse) {
        const previous = stored.get(use.keyId);
        if (previous === undefined || use.at - previous < KEY_LAST_USED_RESOLUTION_MS) continue;
        await tx.update(monetizationKeys).set({ lastUsedAt: new Date(use.at).toISOString() }).where(eq(monetizationKeys.id, use.keyId));
      }
    }

    const cursorValues = { epoch, chargedMicros: totals.charged, requests: totals.requests, freeRequests: totals.free, updatedAt: stamp };
    await tx.insert(monetizationSharedCursors)
      .values({ consumerId, ...cursorValues })
      .onConflictDoUpdate({ target: monetizationSharedCursors.consumerId, set: cursorValues });
    return result;
  });
}

/**
 * Writes the shared usage and credits of these consumers (or of every
 * consumer marked dirty, or with `all` of every consumer in the database) to
 * the ledger. Idempotent; see the file comment.
 */
export async function drainSharedMonetization(
  state: SharedState,
  options: { consumerIds?: number[]; all?: boolean; now?: Date } = {}
): Promise<DrainResult> {
  const { redis } = state;
  const keys = monetizationKeyNames(state.namespace);
  const result: DrainResult = { consumers: 0, requests: 0, chargedMicros: 0, credits: 0, credited: new Map(), ran: false };

  const holder = randomUUID();
  let locked = false;
  for (let attempt = 0; attempt < 20 && !locked; attempt++) {
    locked = (await redis.set(keys.drainLock, holder, "PX", LOCK_TTL_MS, "NX")) === "OK";
    // A periodic drain gives way; an explicit one (a top-up, a deletion) waits up to two seconds.
    if (!locked && !options.consumerIds) return result;
    if (!locked) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!locked) throw new Error("Another node is writing shared monetization state to the ledger; try again");
  result.ran = true;

  try {
    let ids: number[];
    const dirty = (await redis.smembers(keys.dirty)).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
    if (options.consumerIds) ids = options.consumerIds;
    else if (options.all) ids = (await appDb.select({ id: monetizationConsumers.id }).from(monetizationConsumers)).map((row) => row.id);
    else ids = dirty;
    ids = [...new Set(ids)];

    for (const consumerId of ids) {
      const [hash, raw] = await Promise.all([
        redis.hgetall(keys.consumer(consumerId)),
        redis.lrange(keys.credits(consumerId), 0, CREDIT_BATCH - 1),
      ]);
      const queued = raw.map(parseCreditEntry).filter((entry): entry is SharedCreditEntry => entry !== null);
      const drained = await drainConsumer(consumerId, fieldsOf(hash), queued, options.now ?? new Date());
      if (drained === null) {
        // The consumer is gone: nothing of it can be written any more.
        await redis.del(keys.consumer(consumerId), keys.credits(consumerId));
      } else {
        // Written (or not credits at all): out of the queue, each by its value.
        for (const value of raw) await redis.lrem(keys.credits(consumerId), 1, value);
        if (drained.requests > 0 || drained.credits.length > 0) result.consumers += 1;
        result.requests += drained.requests;
        result.chargedMicros += drained.chargedMicros;
        result.credits += drained.credits.length;
        for (const credit of drained.credits) result.credited.set(credit.id, credit.ledgerId);
      }
      if (dirty.includes(consumerId) && raw.length < CREDIT_BATCH) await redis.srem(keys.dirty, String(consumerId));
    }
    await writeDrainStatus(state, { at: new Date().toISOString(), consumers: result.consumers, credits: result.credits, error: null });
    return result;
  } catch (error) {
    await writeDrainStatus(state, {
      at: new Date().toISOString(),
      consumers: result.consumers,
      credits: result.credits,
      error: "Writing shared usage and credits to the ledger failed; it is retried",
    }).catch(() => undefined);
    throw error;
  } finally {
    await runScript(redis, RELEASE_LOCK, [keys.drainLock], [holder]).catch(() => 0);
  }
}

async function writeDrainStatus(state: SharedState, status: SharedStateDrainStatus): Promise<void> {
  const { drain } = monetizationKeyNames(state.namespace);
  await state.redis.hset(drain, {
    at: status.at ?? "",
    consumers: String(status.consumers),
    credits: String(status.credits),
    error: status.error ?? "",
  });
  await state.redis.pexpire(drain, STATUS_TTL_MS);
}

export async function readDrainStatus(state: SharedState): Promise<SharedStateDrainStatus | null> {
  const fields = fieldsOf(await state.redis.hgetall(monetizationKeyNames(state.namespace).drain));
  if (!fields.at) return null;
  return { at: fields.at, consumers: count(fields.consumers), credits: count(fields.credits), error: fields.error || null };
}

/** Adds consumers charged on this node to the shared dirty set. */
export async function reportTouchedConsumers(state: SharedState, consumerIds: number[]): Promise<void> {
  if (consumerIds.length === 0) return;
  const { dirty } = monetizationKeyNames(state.namespace);
  await state.redis.sadd(dirty, ...consumerIds.map(String));
  await state.redis.pexpire(dirty, MZ_DIRTY_TTL_MS);
}
