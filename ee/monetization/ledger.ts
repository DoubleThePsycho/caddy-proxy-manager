// SPDX-License-Identifier: Elastic-2.0
/**
 * The balance ledger: reading it, and the ways a balance goes up or down
 * outside of usage: Stripe top-ups, postpaid payments, refunds and disputes,
 * manual adjustments. Usage rows are written by the engine's flush
 * (engine.ts), failed-answer credits by answer-credits.ts.
 *
 * A row with an external reference is written at most once: top-ups use
 * "stripe:<checkout session id>", so a webhook delivered twice credits once.
 */
import { and, count, eq, type SQL } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { monetizationConsumers, monetizationLedger } from "@/src/lib/db/schema";
import { refreshConsumer } from "./engine";
import { LEDGER_TYPES, type LedgerEntryView, type LedgerPage, type LedgerType } from "./types";
import { desc, first } from "@/src/lib/db/ops";

type LedgerRow = typeof monetizationLedger.$inferSelect;

export function toLedgerView(row: LedgerRow, consumerName: string | null): LedgerEntryView {
  return {
    id: row.id,
    consumerId: row.consumerId,
    consumerName,
    type: (LEDGER_TYPES as readonly string[]).includes(row.type) ? (row.type as LedgerType) : "adjustment",
    amountMicros: row.amountMicros,
    balanceAfterMicros: row.balanceAfterMicros,
    requests: row.requests,
    freeRequests: row.freeRequests,
    reference: row.externalReference,
    description: row.description,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listLedger(options: {
  consumerId?: number | null;
  type?: LedgerType | null;
  page?: number;
  perPage?: number;
}): Promise<LedgerPage> {
  const page = Math.max(1, options.page ?? 1);
  const perPage = Math.min(200, Math.max(1, options.perPage ?? 50));
  const conditions: SQL[] = [];
  if (options.consumerId) conditions.push(eq(monetizationLedger.consumerId, options.consumerId));
  if (options.type) conditions.push(eq(monetizationLedger.type, options.type));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await appDb
    .select({ entry: monetizationLedger, consumerName: monetizationConsumers.name })
    .from(monetizationLedger)
    .leftJoin(monetizationConsumers, eq(monetizationConsumers.id, monetizationLedger.consumerId))
    .where(where)
    .orderBy(desc(monetizationLedger.updatedAt), desc(monetizationLedger.id))
    .limit(perPage)
    .offset((page - 1) * perPage);
  const [{ total }] = await appDb.select({ total: count() }).from(monetizationLedger).where(where);
  return { entries: rows.map((row) => toLedgerView(row.entry, row.consumerName)), total, page, perPage };
}

export type BalanceChange = {
  consumerId: number;
  /** topup, adjustment, payment (postpaid), refund or dispute (negative amounts). */
  type: "topup" | "adjustment" | "payment" | "refund" | "dispute";
  amountMicros: number;
  reference: string | null;
  description: string | null;
  createdBy: number | null;
};

export type BalanceChangeResult =
  /**
   * `entry` is null when the change is in the shared state (high
   * availability) and the leader has not written it to the ledger yet.
   */
  | { status: "applied"; entry: LedgerEntryView | null; balanceMicros: number }
  | { status: "duplicate" }
  | { status: "unknown_consumer" };

/**
 * Adds `amountMicros` (negative to take money off) to the balance and writes
 * the ledger row, in one transaction; then refreshes the in-memory balance.
 * A reference already in the ledger changes nothing.
 */
export async function applyBalanceChange(change: BalanceChange): Promise<BalanceChangeResult> {
  const stamp = nowIso();
  const result = await appDb.transaction(async (tx): Promise<BalanceChangeResult> => {
    if (change.reference) {
      const existing = await first(tx
        .select({ id: monetizationLedger.id })
        .from(monetizationLedger)
        .where(eq(monetizationLedger.externalReference, change.reference))
        .limit(1));
      if (existing) return { status: "duplicate" };
    }
    const consumer = await first(tx
      .select({ balance: monetizationConsumers.balanceMicros, name: monetizationConsumers.name })
      .from(monetizationConsumers)
      .where(eq(monetizationConsumers.id, change.consumerId))
      .limit(1));
    if (!consumer) return { status: "unknown_consumer" };
    const balance = consumer.balance + change.amountMicros;
    await tx.update(monetizationConsumers)
      .set({ balanceMicros: balance, updatedAt: stamp })
      .where(eq(monetizationConsumers.id, change.consumerId));
    const row = (await first(tx
      .insert(monetizationLedger)
      .values({
        consumerId: change.consumerId,
        type: change.type,
        amountMicros: change.amountMicros,
        balanceAfterMicros: balance,
        externalReference: change.reference,
        description: change.description,
        createdBy: change.createdBy,
        createdAt: stamp,
        updatedAt: stamp,
      })
      .returning()))!;
    return { status: "applied", entry: toLedgerView(row, consumer.name), balanceMicros: balance };
  });
  if (result.status === "applied") await refreshConsumer(change.consumerId);
  return result;
}

/** The ledger row with this external reference, or null. */
export async function ledgerEntryByReference(reference: string): Promise<LedgerEntryView | null> {
  const row = await first(appDb
    .select({ entry: monetizationLedger, consumerName: monetizationConsumers.name })
    .from(monetizationLedger)
    .leftJoin(monetizationConsumers, eq(monetizationConsumers.id, monetizationLedger.consumerId))
    .where(eq(monetizationLedger.externalReference, reference))
    .limit(1));
  return row ? toLedgerView(row.entry, row.consumerName) : null;
}

/** The ledger row with this id, or null. */
export async function ledgerEntryById(id: number): Promise<LedgerEntryView | null> {
  const row = await first(appDb
    .select({ entry: monetizationLedger, consumerName: monetizationConsumers.name })
    .from(monetizationLedger)
    .leftJoin(monetizationConsumers, eq(monetizationConsumers.id, monetizationLedger.consumerId))
    .where(eq(monetizationLedger.id, id))
    .limit(1));
  return row ? toLedgerView(row.entry, row.consumerName) : null;
}

/** The most recent ledger rows of one consumer (portal and consumer API). */
export async function recentLedger(consumerId: number, limit = 20): Promise<LedgerEntryView[]> {
  return (await appDb
    .select()
    .from(monetizationLedger)
    .where(eq(monetizationLedger.consumerId, consumerId))
    .orderBy(desc(monetizationLedger.updatedAt), desc(monetizationLedger.id))
    .limit(limit))
    .map((row) => toLedgerView(row, null));
}
