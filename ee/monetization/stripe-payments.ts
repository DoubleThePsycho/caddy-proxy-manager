// SPDX-License-Identifier: Elastic-2.0
/**
 * The record of consumers' Stripe payments (monetization_payments): Checkout
 * top-ups, off-session charges of postpaid consumers' saved cards and open
 * amounts paid in Checkout, with their PaymentIntent, so that Stripe's later
 * refund and dispute events find the consumer they belong to.
 *
 * Refunds and disputes are written to the ledger as money that went back to
 * the payer: the refunded or disputed amount comes off the balance (ledger
 * types "refund" and "dispute"), so the balance stays "paid in minus used".
 * Each is written once: refunds by "stripe-refund:<charge>:<total refunded>"
 * (Stripe reports the running total), disputes by "stripe-dispute:<id>". A
 * dispute also suspends a postpaid consumer until an administrator resumes
 * it. Never checks the license.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { monetizationConsumers, monetizationPayments } from "@/src/lib/db/schema";
import { desc, first } from "@/src/lib/db/ops";
import { withClusterLock } from "@/src/lib/db/locks";
import { logAuditEvent } from "@/src/lib/audit";
import { formatMicros, minorToMicros, MAX_AMOUNT_MICROS } from "./money";
import type { PaymentView } from "./types";

type PaymentRow = typeof monetizationPayments.$inferSelect;

const KINDS = new Set(["topup", "charge", "open_amount"]);
const STATUSES = new Set(["pending", "succeeded", "failed", "requires_action", "canceled"]);

export function toPaymentView(row: PaymentRow): PaymentView {
  return {
    id: row.id,
    consumerId: row.consumerId,
    kind: (KINDS.has(row.kind) ? row.kind : "charge") as PaymentView["kind"],
    reason: row.reason,
    status: (STATUSES.has(row.status) ? row.status : "failed") as PaymentView["status"],
    amountMicros: row.amountMicros,
    currency: row.currency,
    period: row.period,
    paymentIntentId: row.paymentIntentId,
    failureCode: row.failureCode,
    refundedMicros: row.refundedMicros,
    disputedMicros: row.disputedMicros,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A consumer's payments, newest first (at most `limit`), or every consumer's. */
export async function listPayments(options: { consumerId?: number | null; limit?: number } = {}): Promise<PaymentView[]> {
  const limit = Math.min(500, Math.max(1, options.limit ?? 50));
  const rows = await appDb
    .select()
    .from(monetizationPayments)
    .where(options.consumerId ? eq(monetizationPayments.consumerId, options.consumerId) : undefined)
    .orderBy(desc(monetizationPayments.id))
    .limit(limit);
  return rows.map(toPaymentView);
}

/** Amounts of charges sent to Stripe whose outcome is not known yet, by consumer. */
export async function pendingChargeTotals(consumerIds?: readonly number[]): Promise<Map<number, number>> {
  if (consumerIds && consumerIds.length === 0) return new Map();
  const rows = await appDb
    .select({ consumerId: monetizationPayments.consumerId, total: sql<number>`coalesce(sum(${monetizationPayments.amountMicros}), 0)`.mapWith(Number) })
    .from(monetizationPayments)
    .where(
      and(
        eq(monetizationPayments.kind, "charge"),
        eq(monetizationPayments.status, "pending"),
        consumerIds ? inArray(monetizationPayments.consumerId, [...consumerIds]) : undefined
      )
    )
    .groupBy(monetizationPayments.consumerId);
  return new Map(rows.map((row) => [row.consumerId, row.total]));
}

/**
 * Records a payment made in Checkout (a top-up or an open amount) once it was
 * credited; the same session or PaymentIntent again changes nothing.
 */
export async function recordCheckoutPayment(payment: {
  consumerId: number;
  kind: "topup" | "open_amount";
  amountMicros: number;
  currency: string;
  checkoutSessionId: string;
  paymentIntentId: string | null;
  ledgerId: number | null;
}): Promise<void> {
  const stamp = nowIso();
  // Any unique key already there (the session, or its PaymentIntent): recorded before.
  await appDb.insert(monetizationPayments).values({ ...payment, status: "succeeded", createdAt: stamp, updatedAt: stamp }).onConflictDoNothing();
}

/** The payment of a PaymentIntent, or null. */
export async function paymentByIntent(paymentIntentId: string): Promise<PaymentRow | null> {
  return await first(appDb.select().from(monetizationPayments).where(eq(monetizationPayments.paymentIntentId, paymentIntentId)).limit(1)) ?? null;
}

/** A refund or dispute of a payment with no row here (yet): payments.ts looks it up in Stripe. */
export const NOT_RECORDED = "payment not recorded here";

type CreditStore = { credit: (change: import("./ledger").BalanceChange) => Promise<import("./ledger").BalanceChangeResult> };

/**
 * charge.refunded: the refunded total of a payment's charge grew. The
 * difference comes off the balance once. Under the consumer's charge lock
 * (the one postpaid charges take), with the payment read again inside it:
 * two partial refunds of one payment arriving together take off the larger
 * total once, never the sum of both differences.
 */
export async function applyRefund(
  store: CreditStore,
  input: { paymentIntentId: string; chargeId: string; refundedMinor: number; currency: string }
): Promise<{ handled: boolean; reason?: string; amountMicros?: number }> {
  const found = await paymentByIntent(input.paymentIntentId);
  if (!found) return { handled: false, reason: NOT_RECORDED };
  return await withClusterLock(`monetization-charge:${found.consumerId}`, async () => {
    const payment = await paymentByIntent(input.paymentIntentId);
    if (!payment) return { handled: false, reason: NOT_RECORDED };
    if (input.currency !== payment.currency) return { handled: false, reason: "currency mismatch" };
    const refunded = minorToMicros(input.refundedMinor, payment.currency);
    if (!Number.isSafeInteger(refunded) || refunded <= 0 || refunded > MAX_AMOUNT_MICROS) return { handled: false, reason: "no amount" };
    const total = Math.min(refunded, payment.amountMicros);
    const delta = total - payment.refundedMicros;
    if (delta <= 0) return { handled: true, amountMicros: 0 };
    const result = await store.credit({
      consumerId: payment.consumerId,
      type: "refund",
      amountMicros: -delta,
      reference: `stripe-refund:${input.chargeId}:${total}`,
      description: `Stripe refund of payment ${payment.paymentIntentId}`,
      createdBy: null,
    });
    if (result.status === "unknown_consumer") return { handled: false, reason: "unknown consumer" };
    await appDb
      .update(monetizationPayments)
      .set({ refundedMicros: sql`CASE WHEN ${monetizationPayments.refundedMicros} < ${total} THEN ${total} ELSE ${monetizationPayments.refundedMicros} END`, updatedAt: nowIso() })
      .where(eq(monetizationPayments.id, payment.id));
    if (result.status === "applied") {
      await logAuditEvent({
        userId: null,
        action: "refund",
        entityType: "monetization_consumer",
        entityId: payment.consumerId,
        summary: `Stripe refunded ${formatMicros(delta, payment.currency)} of a payment of API consumer ${payment.consumerId}`,
        data: { paymentId: payment.id, amountMicros: delta },
      });
    }
    return { handled: true, amountMicros: result.status === "applied" ? delta : 0 };
  });
}

/**
 * charge.dispute.created: the disputed amount comes off the balance once, and
 * the consumer is suspended (postpaid) by the caller. Under the consumer's
 * charge lock, like refunds.
 */
export async function applyDispute(
  store: CreditStore,
  input: { paymentIntentId: string; disputeId: string; amountMinor: number; currency: string }
): Promise<{ handled: boolean; reason?: string; consumerId?: number; amountMicros?: number }> {
  const found = await paymentByIntent(input.paymentIntentId);
  if (!found) return { handled: false, reason: NOT_RECORDED };
  return await withClusterLock(`monetization-charge:${found.consumerId}`, async () => {
    const payment = await paymentByIntent(input.paymentIntentId);
    if (!payment) return { handled: false, reason: NOT_RECORDED };
    if (input.currency !== payment.currency) return { handled: false, reason: "currency mismatch" };
    const disputed = Math.min(minorToMicros(input.amountMinor, payment.currency), payment.amountMicros);
    if (!Number.isSafeInteger(disputed) || disputed <= 0) return { handled: false, reason: "no amount" };
    const result = await store.credit({
      consumerId: payment.consumerId,
      type: "dispute",
      amountMicros: -disputed,
      reference: `stripe-dispute:${input.disputeId}`,
      description: `Stripe dispute of payment ${payment.paymentIntentId}`,
      createdBy: null,
    });
    if (result.status === "unknown_consumer") return { handled: false, reason: "unknown consumer" };
    if (result.status === "applied") {
      await appDb
        .update(monetizationPayments)
        .set({ disputedMicros: sql`${monetizationPayments.disputedMicros} + ${disputed}`, updatedAt: nowIso() })
        .where(eq(monetizationPayments.id, payment.id));
      await logAuditEvent({
        userId: null,
        action: "dispute",
        entityType: "monetization_consumer",
        entityId: payment.consumerId,
        summary: `A payment of API consumer ${payment.consumerId} is disputed (${formatMicros(disputed, payment.currency)})`,
        data: { paymentId: payment.id, amountMicros: disputed },
      });
    }
    return { handled: true, consumerId: payment.consumerId, amountMicros: result.status === "applied" ? disputed : 0 };
  });
}

/** Whether the consumer exists (webhooks for deleted consumers are acknowledged and ignored). */
export async function consumerExists(consumerId: number): Promise<boolean> {
  return Boolean(await first(appDb.select({ id: monetizationConsumers.id }).from(monetizationConsumers).where(eq(monetizationConsumers.id, consumerId)).limit(1)));
}
