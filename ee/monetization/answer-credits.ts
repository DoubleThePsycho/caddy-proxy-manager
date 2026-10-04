// SPDX-License-Identifier: Elastic-2.0
/**
 * Failed-answer credits: on plans with "don't charge for failed answers"
 * (creditFailedAnswers), a request whose answer was a 5xx (the upstream's
 * own 5xx, or Caddy's 502, 503 or 504 when the upstream could not answer) is
 * credited back.
 *
 * The request is still admitted against the balance when it arrives (the
 * gate does not wait for the answer; the postpaid cap or the overdraft covers
 * the lag). The gate answers it with a charge id (charge-id.ts) that Caddy
 * writes into the request's access log line (field "ingressi_charge"), next
 * to the status the client got. The access-log pipeline (src/lib/log-parser.ts)
 * hands every line with a charge id and a 5xx status to
 * creditFailedAnswers(), which checks the id's MAC and age and credits the
 * charge back through the balance store:
 *
 *  - without shared state, in one database transaction: the charge ids go
 *    into monetization_answer_credits (primary key: the id), and only the
 *    ones not already there are added to the balance and to the hour's
 *    "credit" ledger row (reference "answer-credit:<consumer>:<hour>");
 *  - with high availability shared state, in one atomic script in Redis or
 *    Valkey, which remembers each id it credited, and the leader writes the
 *    credit to the ledger like any other.
 *
 * So a log line read twice (a crash before the parser stored its position,
 * a rotated log) credits once. Free monthly requests that failed are given
 * back too, when they are of the current month. Ids older than
 * MAX_CHARGE_AGE_MS are not credited, and their rows are pruned after that
 * (with the usage retention job).
 *
 * The option needs ClickHouse analytics, the pipeline that reads the access
 * log: without it the gate issues no charge ids. Never checks the license.
 */
import { lt, sql, eq } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { monetizationAnswerCredits, monetizationConsumers, monetizationLedger } from "@/src/lib/db/schema";
import { first } from "@/src/lib/db/ops";
import { readChargeId } from "./charge-id";
import { currentChargeKey, ensureMonetizationLoaded, refreshConsumer, returnFreeRequests } from "./engine";
import { CHARGE_LOG_FIELD } from "./types";

/** Charge ids older than this are not credited (the access log is read every 30 seconds). */
export const MAX_CHARGE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Ids from the future beyond clock skew are refused. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** Credits that failed to be written are retried with the next pass, at most this many. */
const MAX_PENDING = 50_000;
const BATCH = 200;

export const ANSWER_CREDIT_DESCRIPTION = "Failed answers credited back";

/** One request to credit back. `sameMonth`: a free request of the current month (its free request is given back). */
export type AnswerCreditItem = { chargeId: string; amountMicros: number; free: boolean; sameMonth: boolean };

export type AnswerCreditResult = { requests: number; amountMicros: number; freeRequests: number };

/** The ledger reference of a consumer's credits in the hour of `now`. */
export function answerCreditReference(consumerId: number, now: number): string {
  return `answer-credit:${consumerId}:${new Date(now).toISOString().slice(0, 13)}`;
}

function isFailedStatus(status: unknown): boolean {
  return typeof status === "number" && Number.isInteger(status) && status >= 500 && status <= 599;
}

/**
 * The charge ids of access log lines answered with a 5xx. Lines without the
 * field are skipped before they are parsed.
 */
export function failedAnswerChargeIds(lines: readonly string[]): string[] {
  const ids: string[] = [];
  for (const line of lines) {
    if (!line.includes(CHARGE_LOG_FIELD)) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record.msg !== "handled request" || !isFailedStatus(record.status)) continue;
    const id = record[CHARGE_LOG_FIELD];
    if (typeof id === "string" && id.length > 0 && id.length <= 120) ids.push(id);
  }
  return ids;
}

/**
 * The local store's credit (no shared state): the ids not credited before,
 * on the balance and the hour's ledger row, in one transaction.
 */
export async function applyAnswerCreditsLocally(consumerId: number, items: AnswerCreditItem[], now: number): Promise<AnswerCreditResult | null> {
  if (items.length === 0) return { requests: 0, amountMicros: 0, freeRequests: 0 };
  const stamp = new Date(now).toISOString();
  const month = stamp.slice(0, 7);
  const byId = new Map(items.map((item) => [item.chargeId, item]));
  const result = await appDb.transaction(async (tx) => {
    const consumer = await first(tx.select({ id: monetizationConsumers.id }).from(monetizationConsumers).where(eq(monetizationConsumers.id, consumerId)).limit(1));
    if (!consumer) return null;
    const fresh: AnswerCreditItem[] = [];
    for (let index = 0; index < items.length; index += BATCH) {
      const inserted = await tx
        .insert(monetizationAnswerCredits)
        .values(items.slice(index, index + BATCH).map((item) => ({
          chargeId: item.chargeId,
          consumerId,
          amountMicros: item.amountMicros,
          free: item.free,
          createdAt: stamp,
        })))
        .onConflictDoNothing({ target: monetizationAnswerCredits.chargeId })
        .returning({ chargeId: monetizationAnswerCredits.chargeId });
      for (const row of inserted) fresh.push(byId.get(row.chargeId)!);
    }
    if (fresh.length === 0) return { requests: 0, amountMicros: 0, freeRequests: 0, freeThisMonth: 0 };
    const amount = fresh.reduce((sum, item) => sum + item.amountMicros, 0);
    const freeRequests = fresh.filter((item) => item.free).length;
    const freeThisMonth = fresh.filter((item) => item.free && item.sameMonth).length;
    const updated = (await first(tx
      .update(monetizationConsumers)
      .set({
        balanceMicros: sql`${monetizationConsumers.balanceMicros} + ${amount}`,
        freeUsageCount: sql`CASE WHEN ${monetizationConsumers.freeUsageMonth} = ${month} THEN (CASE WHEN ${monetizationConsumers.freeUsageCount} > ${freeThisMonth} THEN ${monetizationConsumers.freeUsageCount} - ${freeThisMonth} ELSE 0 END) ELSE ${monetizationConsumers.freeUsageCount} END`,
      })
      .where(eq(monetizationConsumers.id, consumerId))
      .returning({ balance: monetizationConsumers.balanceMicros })))!;
    await tx.insert(monetizationLedger)
      .values({
        consumerId,
        type: "credit",
        amountMicros: amount,
        balanceAfterMicros: updated.balance,
        requests: fresh.length,
        freeRequests,
        externalReference: answerCreditReference(consumerId, now),
        description: ANSWER_CREDIT_DESCRIPTION,
        createdAt: stamp,
        updatedAt: stamp,
      })
      .onConflictDoUpdate({
        target: monetizationLedger.externalReference,
        set: {
          amountMicros: sql`${monetizationLedger.amountMicros} + ${amount}`,
          balanceAfterMicros: updated.balance,
          requests: sql`${monetizationLedger.requests} + ${fresh.length}`,
          freeRequests: sql`${monetizationLedger.freeRequests} + ${freeRequests}`,
          updatedAt: stamp,
        },
      });
    return { requests: fresh.length, amountMicros: amount, freeRequests, freeThisMonth };
  });
  if (!result) return null;
  if (result.requests > 0) {
    returnFreeRequests(consumerId, month, result.freeThisMonth);
    await refreshConsumer(consumerId);
  }
  return { requests: result.requests, amountMicros: result.amountMicros, freeRequests: result.freeRequests };
}

type PendingStore = { ids: string[] };
const pendingStore = globalThis as typeof globalThis & { __ingressiAnswerCredits?: PendingStore };
function pending(): PendingStore {
  return (pendingStore.__ingressiAnswerCredits ??= { ids: [] });
}

/** The verified items of these ids, by consumer. Forged, foreign, too old and future ids are dropped. */
export function groupChargeIds(key: Buffer, ids: readonly string[], now: number): Map<number, AnswerCreditItem[]> {
  const month = new Date(now).toISOString().slice(0, 7);
  const groups = new Map<number, AnswerCreditItem[]>();
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const fields = readChargeId(key, id);
    if (!fields) continue;
    if (now - fields.issuedAtMs > MAX_CHARGE_AGE_MS || fields.issuedAtMs - now > MAX_CLOCK_SKEW_MS) continue;
    const item: AnswerCreditItem = {
      chargeId: id,
      amountMicros: fields.chargedMicros,
      free: fields.free,
      sameMonth: new Date(fields.issuedAtMs).toISOString().slice(0, 7) === month,
    };
    const list = groups.get(fields.consumerId);
    if (list) list.push(item);
    else groups.set(fields.consumerId, [item]);
  }
  return groups;
}

/**
 * Credits back the requests behind these charge ids (lines answered with a
 * 5xx), with the ones a previous pass could not write. Never throws: what
 * fails is kept for the next pass (up to MAX_PENDING ids).
 */
export async function creditFailedAnswers(ids: readonly string[], now: number = Date.now()): Promise<AnswerCreditResult> {
  const total: AnswerCreditResult = { requests: 0, amountMicros: 0, freeRequests: 0 };
  const queue = pending();
  const work = [...queue.ids, ...ids];
  queue.ids = [];
  if (work.length === 0) return total;
  try {
    await ensureMonetizationLoaded();
  } catch {
    queue.ids = work.slice(-MAX_PENDING);
    return total;
  }
  const key = currentChargeKey();
  if (!key) return total;
  const { monetizationBalanceStore } = await import("./balance-store");
  for (const [consumerId, items] of groupChargeIds(key, work, now)) {
    try {
      const store = await monetizationBalanceStore();
      const result = await store.creditFailedAnswers(consumerId, items, now);
      if (!result) continue;
      total.requests += result.requests;
      total.amountMicros += result.amountMicros;
      total.freeRequests += result.freeRequests;
    } catch {
      // Kept for the next pass; the credit is idempotent per charge id.
      queue.ids.push(...items.map((item) => item.chargeId));
    }
  }
  if (queue.ids.length > MAX_PENDING) queue.ids = queue.ids.slice(-MAX_PENDING);
  if (total.requests > 0 && process.env.MONETIZATION_DEBUG === "1") {
    console.log(`[monetization] Credited back ${total.requests} failed answer(s)`);
  }
  return total;
}

/** Deletes credited charge ids older than the window in which an id is accepted. */
export async function pruneAnswerCredits(now: number = Date.now()): Promise<number> {
  const cutoff = new Date(now - MAX_CHARGE_AGE_MS - 24 * 60 * 60 * 1000).toISOString();
  const removed = await appDb
    .delete(monetizationAnswerCredits)
    .where(lt(monetizationAnswerCredits.createdAt, cutoff))
    .returning({ chargeId: monetizationAnswerCredits.chargeId });
  return removed.length;
}

/** Tests only. */
export function resetAnswerCreditsForTests(): void {
  pendingStore.__ingressiAnswerCredits = { ids: [] };
}
