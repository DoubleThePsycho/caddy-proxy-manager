// SPDX-License-Identifier: Elastic-2.0
/**
 * x402 payments as the ledger, the overview, the attention list and the REST
 * API show them: who paid (address), how much, the settlement transaction,
 * the Stripe PaymentIntent that records it, and its state. Reading only; no
 * license check.
 */
import { and, count, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { monetizationConsumers, monetizationX402Payments, proxyHosts } from "@/src/lib/db/schema";
import { desc } from "@/src/lib/db/ops";
import type { MonetizationX402Summary } from "../types";

/**
 * verifying, settling: in progress. recording: settled on chain, Stripe has
 * not confirmed its PaymentIntent yet. confirmed: Stripe confirmed it, the
 * request not answered yet (the same payload sent again is). settled:
 * confirmed and answered. unrecorded: Stripe refused to record it. unknown:
 * the settlement's outcome never came back. failed: not paid.
 */
export const X402_PAYMENT_STATUSES = ["verifying", "settling", "recording", "confirmed", "settled", "unrecorded", "unknown", "failed"] as const;
export type X402PaymentStatus = (typeof X402_PAYMENT_STATUSES)[number];
/** States the operator should look at: paid or maybe paid, not recorded in Stripe. */
export const X402_ATTENTION_STATUSES = ["recording", "unrecorded", "unknown"] as const;

export type X402PaymentView = {
  id: number;
  proxyHostId: number;
  hostName: string | null;
  /** Set when a key holder paid with x402; null for a payer without an account. */
  consumerId: number | null;
  consumerName: string | null;
  payer: string;
  network: string;
  /** USDC micro-units (six decimals), and the same in US cents. */
  amountMicros: number;
  amountCents: number;
  status: X402PaymentStatus;
  transaction: string | null;
  paymentIntentId: string | null;
  errorReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type X402PaymentPage = { payments: X402PaymentView[]; total: number; page: number; perPage: number };

type Row = typeof monetizationX402Payments.$inferSelect;

function toView(row: Row, hostName: string | null, consumerName: string | null): X402PaymentView {
  return {
    id: row.id,
    proxyHostId: row.proxyHostId,
    hostName,
    consumerId: row.consumerId,
    consumerName,
    payer: row.payer,
    network: row.network,
    amountMicros: row.amountMicros,
    amountCents: Math.round(row.amountMicros / 10_000),
    status: (X402_PAYMENT_STATUSES as readonly string[]).includes(row.status) ? (row.status as X402PaymentStatus) : "failed",
    transaction: row.transaction,
    paymentIntentId: row.paymentIntentId,
    errorReason: row.errorReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listX402Payments(options: { hostId?: number | null; status?: X402PaymentStatus | null; page?: number; perPage?: number } = {}): Promise<X402PaymentPage> {
  const page = Math.max(1, options.page ?? 1);
  const perPage = Math.min(200, Math.max(1, options.perPage ?? 50));
  const conditions: SQL[] = [];
  if (options.hostId) conditions.push(eq(monetizationX402Payments.proxyHostId, options.hostId));
  if (options.status) conditions.push(eq(monetizationX402Payments.status, options.status));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await appDb
    .select({ payment: monetizationX402Payments, hostName: proxyHosts.name, consumerName: monetizationConsumers.name })
    .from(monetizationX402Payments)
    .leftJoin(proxyHosts, eq(proxyHosts.id, monetizationX402Payments.proxyHostId))
    .leftJoin(monetizationConsumers, eq(monetizationConsumers.id, monetizationX402Payments.consumerId))
    .where(where)
    .orderBy(desc(monetizationX402Payments.id))
    .limit(perPage)
    .offset((page - 1) * perPage);
  const [{ total }] = await appDb.select({ total: count() }).from(monetizationX402Payments).where(where);
  return { payments: rows.map((row) => toView(row.payment, row.hostName ?? null, row.consumerName ?? null)), total, page, perPage };
}

/** Payments settled on chain but not recorded in Stripe (or of unknown outcome), oldest first: for the attention list. */
export async function x402PaymentsNeedingAttention(limit: number = 20): Promise<X402PaymentView[]> {
  const rows = await appDb
    .select()
    .from(monetizationX402Payments)
    .where(inArray(monetizationX402Payments.status, [...X402_ATTENTION_STATUSES]))
    .orderBy(monetizationX402Payments.id)
    .limit(limit);
  return rows.map((row) => toView(row, null, null));
}

export type X402MonthSummary = MonetizationX402Summary;

/** This period's x402 payments (from ISO `from`, before `to`). */
export async function summarizeX402(from: string, to: string): Promise<X402MonthSummary> {
  const rows = await appDb
    .select({
      status: monetizationX402Payments.status,
      payments: sql<number>`count(*)`.mapWith(Number),
      amountMicros: sql<number>`coalesce(sum(${monetizationX402Payments.amountMicros}), 0)`.mapWith(Number),
    })
    .from(monetizationX402Payments)
    .where(and(gte(monetizationX402Payments.createdAt, from), lt(monetizationX402Payments.createdAt, to)))
    .groupBy(monetizationX402Payments.status);
  const summary: X402MonthSummary = { settled: 0, failed: 0, pending: 0, amountCents: 0 };
  for (const row of rows) {
    if (row.status === "settled" || row.status === "confirmed") {
      summary.settled += row.payments;
      summary.amountCents += Math.round(row.amountMicros / 10_000);
    } else if (row.status === "failed") summary.failed += row.payments;
    else if ((X402_ATTENTION_STATUSES as readonly string[]).includes(row.status)) summary.pending += row.payments;
  }
  return summary;
}
