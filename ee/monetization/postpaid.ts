// SPDX-License-Identifier: Elastic-2.0
/**
 * Postpaid consumers: usage first, paid afterwards with a card saved up front,
 * never beyond the plan's hard cap.
 *
 *  - Card: the consumer saves a card through Stripe Checkout in setup mode
 *    (from the portal), for a Stripe Customer in the operator's account that
 *    carries metadata.ingressi_install and the consumer id. Only the card's
 *    brand, last four digits and expiry are kept, with the PaymentMethod id.
 *    Without a usable card (none saved, or expired) the gate answers 402
 *    payment_method_required.
 *  - Cap: the gate admits a request while the unpaid usage after it stays
 *    within the plan's cap (engine.ts: the balance may go down to minus the
 *    cap), so at most the cap is ever owed, whatever happens to a charge.
 *  - Charges: the leader charges the saved card off-session when the open
 *    amount reaches the plan's threshold and at the end of each billing
 *    period (the 1st of the month, UTC), and before a card expires. A charge
 *    row (monetization_payments, "pending", with its Stripe idempotency key)
 *    is written before Stripe is called; the PaymentIntent carries
 *    metadata.ingressi_charge_id. On success the amount is credited to the
 *    balance (ledger "payment", reference "stripe-pi:<PaymentIntent>"), from
 *    the API's answer or from the payment_intent.succeeded webhook, whichever
 *    comes first, once. A charge whose answer was lost (a crash, an outage)
 *    stays pending, counts as on its way (it is not charged twice), and is
 *    reconciled with the same idempotency key (reconcilePendingCharges).
 *  - Failure: a declined charge, or one the card holder must authenticate,
 *    suspends the consumer: 402 payment_overdue with a link to the portal,
 *    where the open amount is paid in Checkout (which also saves the card
 *    again). Paying clears the suspension. A dispute suspends the consumer
 *    until an administrator resumes it.
 *  - Switching between prepaid and postpaid settles first: the consumer must
 *    owe nothing and have no charge on its way.
 *
 * Receipts are Stripe's (the operator's Stripe settings); Ingressi issues no
 * invoices. Licensing: charging, saving cards, paying and the billing job
 * never check the license (a licence never touches traffic); resuming a
 * suspended consumer is a change and needs "api_monetization".
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { monetizationConsumers, monetizationPayments, monetizationPlans } from "@/src/lib/db/schema";
import { first } from "@/src/lib/db/ops";
import { tryWithClusterLock, withClusterLock } from "@/src/lib/db/locks";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiClientError, ApiConflictError } from "@/src/lib/api-errors";
import { requireFeature } from "@/ee/licensing/store";
import { refreshConsumer } from "./engine";
import { monetizationBalanceStore, type LiveCounters } from "./balance-store";
import {
  cardExpiresAt,
  chargeableMicros,
  effectiveThreshold,
  isCardExpired,
  minimumChargeMicros,
  nextPeriodStart,
  openAmountToPay,
  previousPeriod,
} from "./billing-rules";
import { formatMicros, microsToMinor, minorToMicros, MAX_AMOUNT_MICROS } from "./money";
import { ensureGateSecret, readCurrency, readStoredPayments, readStripeSecrets } from "./settings";
import { ID_PATTERNS, PaymentProviderError, errorSuffix, readCard, stripeId, stripeRequest, type StripeReply } from "./stripe-api";
import { pendingChargeTotals } from "./stripe-payments";
import { FEATURE, readSuspensionReason, type BillingMode, type CardView, type PostpaidView, type SuspensionReason } from "./types";
import { clearStripeKeyRejection, noteStripeKeyRejected, STRIPE_KEY_REJECTED } from "./stripe-status";

type ConsumerRow = typeof monetizationConsumers.$inferSelect;
type PlanRow = typeof monetizationPlans.$inferSelect;
type PaymentRow = typeof monetizationPayments.$inferSelect;

export type ChargeReason = "threshold" | "period" | "expiry" | "manual" | "billing_switch";

export type ChargeOutcome =
  | { status: "succeeded"; paymentId: number; amountMicros: number }
  | { status: "pending"; paymentId: number; amountMicros: number }
  | { status: "failed"; paymentId: number; amountMicros: number; code: string | null }
  | { status: "skipped"; reason: string };

/** A pending charge older than this without an answer is reconciled. */
const RECONCILE_AFTER_MS = 60_000;
/** Stripe keeps idempotency keys for 24 hours: a charge is sent again with its key only within this. */
const REPLAY_WINDOW_MS = 23 * 60 * 60 * 1000;
/** A card that expires within this is charged for the open amount first. */
const EXPIRY_CHARGE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

// ── Billing in effect ────────────────────────────────────────────────

export function effectiveBilling(row: Pick<ConsumerRow, "billing">, plan: Pick<PlanRow, "billing"> | null | undefined): BillingMode {
  if (row.billing === "postpaid" || row.billing === "prepaid") return row.billing;
  return plan?.billing === "postpaid" ? "postpaid" : "prepaid";
}

async function readConsumer(consumerId: number): Promise<ConsumerRow | null> {
  return await first(appDb.select().from(monetizationConsumers).where(eq(monetizationConsumers.id, consumerId)).limit(1)) ?? null;
}

async function readPlan(planId: number | null): Promise<PlanRow | null> {
  if (planId === null) return null;
  return await first(appDb.select().from(monetizationPlans).where(eq(monetizationPlans.id, planId)).limit(1)) ?? null;
}

async function liveBalance(row: ConsumerRow): Promise<number> {
  return (await (await monetizationBalanceStore()).liveCounters([row])).get(row.id)?.balanceMicros ?? row.balanceMicros;
}

type StripeContext = { secretKey: string; installId: string; currency: string; automaticTax: boolean };

/** The operator's Stripe key and this install's id; 409 while payments are not set up. */
async function stripeContext(): Promise<StripeContext> {
  const stored = await readStoredPayments();
  const { secretKey } = await readStripeSecrets(stored);
  if (!secretKey) throw new ApiConflictError("Payments are not available yet");
  return {
    secretKey,
    installId: (await ensureGateSecret()).installId,
    currency: await readCurrency(stored),
    automaticTax: stored.automaticTax === true,
  };
}

function cardView(row: ConsumerRow, now: number): CardView | null {
  if (!row.paymentMethodId) return null;
  return {
    brand: row.cardBrand,
    last4: row.cardLast4,
    expMonth: row.cardExpMonth,
    expYear: row.cardExpYear,
    expired: isCardExpired(row.cardExpMonth, row.cardExpYear, now),
  };
}

function readSuspension(row: ConsumerRow): SuspensionReason | null {
  if (!row.suspendedAt) return null;
  return readSuspensionReason(row.suspendedReason);
}

function postpaidState(row: ConsumerRow, now: number): PostpaidView["state"] {
  if (readSuspension(row)) return "suspended";
  if (!row.paymentMethodId || isCardExpired(row.cardExpMonth, row.cardExpYear, now)) return "needs_card";
  return "active";
}

/** The postpaid view of each postpaid consumer among `rows`. */
export async function postpaidViews(
  rows: ConsumerRow[],
  counters: Map<number, LiveCounters>,
  now: number = Date.now()
): Promise<Map<number, PostpaidView>> {
  const views = new Map<number, PostpaidView>();
  if (rows.length === 0) return views;
  const planIds = [...new Set(rows.map((row) => row.planId).filter((id): id is number => id !== null))];
  const plans = new Map(
    planIds.length === 0 ? [] : (await appDb.select().from(monetizationPlans).where(inArray(monetizationPlans.id, planIds))).map((plan) => [plan.id, plan])
  );
  const postpaid = rows.filter((row) => effectiveBilling(row, row.planId === null ? null : plans.get(row.planId)) === "postpaid");
  if (postpaid.length === 0) return views;
  const pending = await pendingChargeTotals(postpaid.map((row) => row.id));
  for (const row of postpaid) {
    const plan = row.planId === null ? undefined : plans.get(row.planId);
    const cap = plan?.postpaidCapMicros ?? 0;
    const balance = counters.get(row.id)?.balanceMicros ?? row.balanceMicros;
    views.set(row.id, {
      openAmountMicros: Math.max(0, -balance),
      pendingChargeMicros: pending.get(row.id) ?? 0,
      capMicros: cap,
      thresholdMicros: effectiveThreshold(cap, plan?.postpaidThresholdMicros ?? null),
      state: postpaidState(row, now),
      suspendedReason: readSuspension(row),
      suspendedAt: row.suspendedAt,
      card: cardView(row, now),
      nextPeriodChargeAt: nextPeriodStart(now),
    });
  }
  return views;
}

/** Why a billing switch is refused while replicas share this master's state. */
export const SHARED_REPLICAS_SWITCH_MESSAGE =
  "While replicas serve monetized hosts through shared state, billing cannot switch between prepaid and postpaid: " +
  "the replicas would keep the old billing and limit until their next sync. Serve them with allowances, or turn replica serving off, first";

/** 409 when replicas of this master gate with shared state (see switchBilling). */
export async function assertNoSharedReplicas(): Promise<void> {
  const { getInstanceMode } = await import("@/src/lib/instance-sync");
  if ((await getInstanceMode()) !== "master") return;
  const { getMonetizationOptions } = await import("./options");
  if ((await getMonetizationOptions()).replicaMode === "shared") throw new ApiConflictError(SHARED_REPLICAS_SWITCH_MESSAGE);
}

/** A "billing_switch" suspension older than this was left by a switch that stopped (a crash). */
export const SWITCH_SUSPENSION_STALE_MS = 2 * 60_000;

/** Marks the consumer as switching (402 payment_overdue, reason billing_switch); false when it is suspended already. */
async function markSwitching(consumerId: number): Promise<boolean> {
  const stamp = nowIso();
  const marked = await appDb
    .update(monetizationConsumers)
    .set({ suspendedAt: stamp, suspendedReason: "billing_switch", updatedAt: stamp })
    .where(and(eq(monetizationConsumers.id, consumerId), isNull(monetizationConsumers.suspendedAt)))
    .returning({ id: monetizationConsumers.id });
  return marked.length > 0;
}

/** Ends a "billing_switch" suspension (only that reason: a charge that failed meanwhile keeps its own). */
async function clearSwitching(consumerId: number, olderThan?: string): Promise<boolean> {
  const cleared = await appDb
    .update(monetizationConsumers)
    .set({ suspendedAt: null, suspendedReason: null, updatedAt: nowIso() })
    .where(
      and(
        eq(monetizationConsumers.id, consumerId),
        eq(monetizationConsumers.suspendedReason, "billing_switch"),
        olderThan ? lt(monetizationConsumers.suspendedAt, olderThan) : undefined
      )
    )
    .returning({ id: monetizationConsumers.id });
  return cleared.length > 0;
}

/**
 * Switches a consumer between prepaid and postpaid (consumers.ts), under its
 * charge lock, so that no charge, refund or other switch of the consumer
 * runs meanwhile:
 *  - refused (409) while replicas serve monetized hosts through shared
 *    state: they would keep the old billing and limit until their next sync
 *    (allowance replicas are charged by this master, which switches at once);
 *  - refused (409) while a charge of the consumer is on its way, or while it
 *    is suspended (a failed charge, a dispute: settle that first);
 *  - leaving postpaid: the consumer is suspended first ("billing_switch",
 *    402 with that reason and Retry-After), so the gate admits nothing more
 *    under the old cap while the open amount is charged to the saved card;
 *    then the balance is read again and any residue (requests admitted
 *    before the suspension reached every node) charged too. An amount below
 *    Stripe's minimum charge cannot be charged and stays as a small negative
 *    balance. Then the new billing is written and the suspension ended. A
 *    charge that does not go through refuses the switch (409) and ends the
 *    switching suspension (a declined card leaves its own suspension, as
 *    any failed charge). A switch that stops half way (a crash) leaves the
 *    suspension, which clearStaleSwitchSuspensions ends within minutes;
 *  - entering postpaid, a negative prepaid balance becomes the open amount,
 *    charged like any other.
 * `apply` writes the new billing; the gate follows it at once.
 */
export async function switchBilling(row: ConsumerRow, from: BillingMode, apply: () => Promise<void>): Promise<void> {
  await withClusterLock(`monetization-charge:${row.id}`, async () => {
    await assertNoSharedReplicas();
    if (((await pendingChargeTotals([row.id])).get(row.id) ?? 0) > 0) {
      throw new ApiConflictError("A charge of this consumer is in progress: switch between prepaid and postpaid once it has gone through");
    }
    if (from !== "postpaid") {
      await apply();
      return;
    }
    if (!(await markSwitching(row.id))) {
      throw new ApiConflictError("This consumer is suspended: settle the open amount (or resume it) before switching away from postpaid");
    }
    try {
      // The gate refuses the consumer from here on: no usage under the old cap while it is charged.
      await refreshConsumer(row.id);
      for (let pass = 0; pass < 2; pass++) {
        const current = (await readConsumer(row.id)) ?? row;
        if ((await liveBalance(current)) >= 0) break;
        const outcome = await chargeOpenAmount(row.id, "billing_switch");
        if (outcome.status === "succeeded") continue;
        // An amount below Stripe's minimum cannot be charged: it stays as a small negative balance.
        if (outcome.status === "skipped" && outcome.reason === "below the minimum charge") break;
        const why = outcome.status === "skipped" ? outcome.reason : outcome.status === "failed" ? `the charge failed (${outcome.code ?? "declined"})` : "the charge is still on its way";
        throw new ApiConflictError(`Switching away from postpaid charges the open amount first, and it was not charged: ${why}. Charge or adjust the open amount, then switch`);
      }
      await apply();
    } finally {
      await clearSwitching(row.id);
      await refreshConsumer(row.id);
    }
  });
}

/**
 * Ends "billing_switch" suspensions left by a switch that stopped half way
 * (older than SWITCH_SUSPENSION_STALE_MS, and only when no switch or charge
 * of the consumer holds its lock). Run by the leader with the billing pass.
 */
export async function clearStaleSwitchSuspensions(now: number = Date.now()): Promise<number> {
  const cutoff = new Date(now - SWITCH_SUSPENSION_STALE_MS).toISOString();
  const stale = await appDb
    .select({ id: monetizationConsumers.id })
    .from(monetizationConsumers)
    .where(and(eq(monetizationConsumers.suspendedReason, "billing_switch"), lt(monetizationConsumers.suspendedAt, cutoff)));
  let cleared = 0;
  for (const { id } of stale) {
    const outcome = await tryWithClusterLock(`monetization-charge:${id}`, async () => {
      if (!(await clearSwitching(id, cutoff))) return false;
      await refreshConsumer(id);
      return true;
    });
    if (outcome.acquired && outcome.value) cleared += 1;
  }
  return cleared;
}

// ── Stripe Customer and card ─────────────────────────────────────────

/** The consumer's Stripe Customer in the operator's account, created on first use. */
export async function ensureStripeCustomer(row: ConsumerRow, context: StripeContext): Promise<string> {
  if (row.stripeCustomerId) return row.stripeCustomerId;
  const params = new URLSearchParams();
  params.set("name", row.name);
  if (row.email) params.set("email", row.email);
  params.set("metadata[ingressi_install]", context.installId);
  params.set("metadata[ingressi_consumer_id]", String(row.id));
  // The same consumer and details within Stripe's 24 hours: the same customer, even after a crash.
  const fingerprint = createHash("sha256").update(params.toString()).digest("hex").slice(0, 16);
  const reply = await stripeRequest(context.secretKey, "POST", "/v1/customers", {
    params,
    idempotencyKey: `ingressi-${context.installId}-customer-${row.id}-${fingerprint}`,
  });
  const id = reply.ok ? stripeId(reply.data.id, ID_PATTERNS.customer) : null;
  if (!id) {
    console.warn(`[monetization] Stripe refused a customer: HTTP ${reply.status}${reply.ok ? "" : errorSuffix(reply)}`);
    throw new PaymentProviderError(`Stripe did not create the customer${reply.ok ? "" : errorSuffix(reply)}`);
  }
  await appDb
    .update(monetizationConsumers)
    .set({ stripeCustomerId: id, updatedAt: nowIso() })
    .where(and(eq(monetizationConsumers.id, row.id), isNull(monetizationConsumers.stripeCustomerId)));
  return (await readConsumer(row.id))?.stripeCustomerId ?? id;
}

async function checkoutUrl(context: StripeContext, params: URLSearchParams, what: string): Promise<string> {
  const reply = await stripeRequest(context.secretKey, "POST", "/v1/checkout/sessions", { params, idempotencyKey: randomUUID() });
  const url = reply.ok && typeof reply.data.url === "string" && reply.data.url.startsWith("https://") ? reply.data.url : null;
  if (!url) {
    console.warn(`[monetization] Stripe refused a checkout session (${what}): HTTP ${reply.status}${reply.ok ? "" : errorSuffix(reply)}`);
    throw new PaymentProviderError(`Stripe did not create the checkout session${reply.ok ? "" : errorSuffix(reply)}`);
  }
  return url;
}

async function requirePostpaidConsumer(consumerId: number): Promise<{ row: ConsumerRow; plan: PlanRow | null }> {
  const row = await readConsumer(consumerId);
  if (!row) throw new ApiClientError("Consumer not found", 404);
  if (row.status !== "active") throw new ApiClientError("This API consumer is disabled", 403);
  const plan = await readPlan(row.planId);
  if (effectiveBilling(row, plan) !== "postpaid") throw new ApiConflictError("This consumer pays prepaid; there is no card to save or amount to pay");
  return { row, plan };
}

/**
 * A Checkout Session in setup mode that saves a card for off-session
 * charges, for the consumer's Stripe Customer. Never checks the license.
 */
export async function createCardSetupCheckout(consumerId: number, urls: { successUrl: string; cancelUrl: string }): Promise<string> {
  const { row } = await requirePostpaidConsumer(consumerId);
  const context = await stripeContext();
  const customer = await ensureStripeCustomer(row, context);
  const params = new URLSearchParams();
  params.set("mode", "setup");
  params.set("customer", customer);
  params.set("currency", context.currency);
  params.set("payment_method_types[0]", "card");
  params.set("success_url", urls.successUrl);
  params.set("cancel_url", urls.cancelUrl);
  params.set("client_reference_id", `ingressi-consumer-${row.id}`);
  params.set("metadata[ingressi_install]", context.installId);
  params.set("metadata[ingressi_consumer_id]", String(row.id));
  params.set("metadata[ingressi_kind]", "card_setup");
  params.set("setup_intent_data[metadata][ingressi_install]", context.installId);
  params.set("setup_intent_data[metadata][ingressi_consumer_id]", String(row.id));
  return await checkoutUrl(context, params, "card setup");
}

/**
 * A Checkout Session paying the consumer's open amount (rounded up to the
 * smallest unit, less charges on their way), which also saves the card used
 * for later charges. Never checks the license.
 */
export async function createOpenAmountCheckout(consumerId: number, urls: { successUrl: string; cancelUrl: string }): Promise<string> {
  const { row } = await requirePostpaidConsumer(consumerId);
  const context = await stripeContext();
  const pending = (await pendingChargeTotals([row.id])).get(row.id) ?? 0;
  const amount = openAmountToPay(-(await liveBalance(row)) - pending, context.currency);
  if (amount <= 0) throw new ApiConflictError("There is no open amount to pay");
  if (amount < minimumChargeMicros(context.currency)) {
    throw new ApiConflictError(`The open amount is below the smallest payment Stripe takes (${formatMicros(minimumChargeMicros(context.currency), context.currency)}); it is charged with the next one`);
  }
  const unitAmount = microsToMinor(amount, context.currency)!;
  const customer = await ensureStripeCustomer(row, context);
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("customer", customer);
  params.set("success_url", urls.successUrl);
  params.set("cancel_url", urls.cancelUrl);
  params.set("client_reference_id", `ingressi-consumer-${row.id}`);
  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", context.currency);
  params.set("line_items[0][price_data][unit_amount]", String(unitAmount));
  params.set("line_items[0][price_data][product_data][name]", `API usage (${formatMicros(amount, context.currency)})`);
  params.set("metadata[ingressi_install]", context.installId);
  params.set("metadata[ingressi_consumer_id]", String(row.id));
  params.set("metadata[ingressi_kind]", "open_amount");
  params.set("payment_intent_data[metadata][ingressi_install]", context.installId);
  params.set("payment_intent_data[metadata][ingressi_consumer_id]", String(row.id));
  params.set("payment_intent_data[metadata][ingressi_kind]", "open_amount");
  params.set("payment_intent_data[setup_future_usage]", "off_session");
  if (context.automaticTax) applyAutomaticTax(params, true);
  return await checkoutUrl(context, params, "open amount");
}

/** Stripe Tax on a Checkout Session (the operator's option): tax on top of the amount, which is what is credited. */
export function applyAutomaticTax(params: URLSearchParams, withCustomer: boolean): void {
  params.set("automatic_tax[enabled]", "true");
  params.set("line_items[0][price_data][tax_behavior]", "exclusive");
  params.set("billing_address_collection", "required");
  if (withCustomer) {
    params.set("customer_update[address]", "auto");
    params.set("customer_update[name]", "auto");
  }
}

export type CardSaveOutcome = { handled: true; consumerId: number } | { handled: false; reason: string };

/**
 * Saves the card of a succeeded SetupIntent (setup_intent.succeeded, or a
 * setup-mode checkout.session.completed) for the consumer in its metadata.
 * The card details are read from Stripe; only brand, last four and expiry are
 * kept. A card saved twice changes nothing.
 */
export async function saveCardFromSetupIntent(setupIntent: Record<string, unknown> | string): Promise<CardSaveOutcome> {
  const context = await stripeContext().catch(() => null);
  if (!context) return { handled: false, reason: "payments not configured" };
  let intent: Record<string, unknown>;
  if (typeof setupIntent === "string") {
    const id = stripeId(setupIntent, ID_PATTERNS.setupIntent);
    if (!id) return { handled: false, reason: "no setup intent" };
    const reply = await stripeRequest(context.secretKey, "GET", `/v1/setup_intents/${id}`, { params: new URLSearchParams([["expand[]", "payment_method"]]) });
    if (!reply.ok) throw new PaymentProviderError(`Stripe did not return the setup intent${errorSuffix(reply)}`);
    intent = reply.data;
  } else {
    intent = setupIntent;
  }
  if (!stripeId(intent.id, ID_PATTERNS.setupIntent)) return { handled: false, reason: "no setup intent" };
  if (intent.status !== "succeeded") return { handled: false, reason: "not succeeded" };
  const metadata = (typeof intent.metadata === "object" && intent.metadata !== null ? intent.metadata : {}) as Record<string, unknown>;
  if (metadata.ingressi_install !== context.installId) return { handled: false, reason: "setup of another install or product" };
  return await saveCard(context, Number(metadata.ingressi_consumer_id), intent.customer, intent.payment_method);
}

/**
 * Saves the card a PaymentIntent was paid with when it was set up for later
 * charges (an open amount paid in Checkout). Best effort: the payment is
 * credited either way.
 */
export async function saveCardFromPaymentIntent(paymentIntentId: string, consumerId: number): Promise<CardSaveOutcome> {
  const context = await stripeContext().catch(() => null);
  if (!context) return { handled: false, reason: "payments not configured" };
  const reply = await stripeRequest(context.secretKey, "GET", `/v1/payment_intents/${paymentIntentId}`, {
    params: new URLSearchParams([["expand[]", "payment_method"]]),
  });
  if (!reply.ok) return { handled: false, reason: "payment intent not readable" };
  const metadata = (typeof reply.data.metadata === "object" && reply.data.metadata !== null ? reply.data.metadata : {}) as Record<string, unknown>;
  if (metadata.ingressi_install !== context.installId || Number(metadata.ingressi_consumer_id) !== consumerId) {
    return { handled: false, reason: "payment of another install or consumer" };
  }
  if (reply.data.setup_future_usage !== "off_session" || reply.data.status !== "succeeded") return { handled: false, reason: "not saved for later" };
  return await saveCard(context, consumerId, reply.data.customer, reply.data.payment_method);
}

async function saveCard(context: StripeContext, consumerId: number, customerValue: unknown, paymentMethodValue: unknown): Promise<CardSaveOutcome> {
  if (!Number.isSafeInteger(consumerId) || consumerId < 1) return { handled: false, reason: "no consumer" };
  const row = await readConsumer(consumerId);
  if (!row) return { handled: false, reason: "unknown consumer" };
  const customer = stripeId(customerValue, ID_PATTERNS.customer);
  // The card must belong to the consumer's own Stripe Customer.
  if (!customer || (row.stripeCustomerId && row.stripeCustomerId !== customer)) return { handled: false, reason: "customer mismatch" };
  let card = readCard(paymentMethodValue);
  if (!card) {
    const paymentMethodId = stripeId(paymentMethodValue, ID_PATTERNS.paymentMethod);
    if (!paymentMethodId) return { handled: false, reason: "no card" };
    const reply = await stripeRequest(context.secretKey, "GET", `/v1/payment_methods/${paymentMethodId}`);
    if (!reply.ok) throw new PaymentProviderError(`Stripe did not return the card${errorSuffix(reply)}`);
    if (stripeId(reply.data.customer, ID_PATTERNS.customer) !== customer) return { handled: false, reason: "customer mismatch" };
    card = readCard(reply.data);
  }
  if (!card) return { handled: false, reason: "not a card" };
  if (row.paymentMethodId === card.id) return { handled: true, consumerId };
  await appDb
    .update(monetizationConsumers)
    .set({
      stripeCustomerId: customer,
      paymentMethodId: card.id,
      cardBrand: card.brand,
      cardLast4: card.last4,
      cardExpMonth: card.expMonth,
      cardExpYear: card.expYear,
      updatedAt: nowIso(),
    })
    .where(eq(monetizationConsumers.id, consumerId));
  await refreshConsumer(consumerId);
  await logAuditEvent({
    userId: null,
    action: "save_card",
    entityType: "monetization_consumer",
    entityId: consumerId,
    summary: `API consumer ${row.name} saved a card (${card.brand ?? "card"} ending ${card.last4 ?? "????"})`,
    data: { brand: card.brand, last4: card.last4, expMonth: card.expMonth, expYear: card.expYear },
  });
  return { handled: true, consumerId };
}

/** Forgets the saved card (the consumer then needs a new one). Never needs a license. */
export async function forgetCard(consumerId: number, actorUserId: number): Promise<void> {
  const row = await readConsumer(consumerId);
  if (!row) throw new ApiClientError("Consumer not found", 404);
  if (!row.paymentMethodId) return;
  const paymentMethodId = row.paymentMethodId;
  await appDb
    .update(monetizationConsumers)
    .set({ paymentMethodId: null, cardBrand: null, cardLast4: null, cardExpMonth: null, cardExpYear: null, updatedAt: nowIso() })
    .where(eq(monetizationConsumers.id, consumerId));
  await refreshConsumer(consumerId);
  // Detached in Stripe too, best effort: the card can no longer be charged.
  const context = await stripeContext().catch(() => null);
  if (context) {
    await stripeRequest(context.secretKey, "POST", `/v1/payment_methods/${paymentMethodId}/detach`, { idempotencyKey: `ingressi-detach-${paymentMethodId}` }).catch(() => null);
  }
  await logAuditEvent({
    userId: actorUserId,
    action: "forget_card",
    entityType: "monetization_consumer",
    entityId: consumerId,
    summary: `Removed the saved card of API consumer ${row.name}`,
  });
}

// ── Suspension ───────────────────────────────────────────────────────

/** Suspends a postpaid consumer (402 payment_overdue). A dispute is not replaced by a payment failure. */
export async function suspendConsumer(consumerId: number, reason: SuspensionReason, detail: string): Promise<void> {
  const row = await readConsumer(consumerId);
  if (!row) return;
  if (row.suspendedAt && (row.suspendedReason === reason || row.suspendedReason === "dispute")) return;
  await appDb
    .update(monetizationConsumers)
    .set({ suspendedAt: row.suspendedAt ?? nowIso(), suspendedReason: reason, updatedAt: nowIso() })
    .where(eq(monetizationConsumers.id, consumerId));
  await refreshConsumer(consumerId);
  await logAuditEvent({
    userId: null,
    action: "suspend",
    entityType: "monetization_consumer",
    entityId: consumerId,
    summary: `Suspended API consumer ${row.name}: ${detail}`,
    data: { reason },
  });
}

/** A payment arrived: a suspension for a failed charge ends (a dispute stays until resumed). */
async function clearPaymentSuspension(consumerId: number): Promise<void> {
  const cleared = await appDb
    .update(monetizationConsumers)
    .set({ suspendedAt: null, suspendedReason: null, updatedAt: nowIso() })
    .where(
      and(
        eq(monetizationConsumers.id, consumerId),
        or(eq(monetizationConsumers.suspendedReason, "payment_failed"), eq(monetizationConsumers.suspendedReason, "authentication_required"))
      )
    )
    .returning({ id: monetizationConsumers.id });
  if (cleared.length > 0) {
    await refreshConsumer(consumerId);
    await logAuditEvent({
      userId: null,
      action: "resume",
      entityType: "monetization_consumer",
      entityId: consumerId,
      summary: `API consumer ${consumerId} paid; the suspension ended`,
    });
  }
}

/** An administrator ends a suspension (a dispute, say). Needs the license: it lets requests through again. */
export async function resumeConsumer(consumerId: number, actorUserId: number): Promise<void> {
  const row = await readConsumer(consumerId);
  if (!row) throw new ApiClientError("Consumer not found", 404);
  await requireFeature(FEATURE);
  if (!row.suspendedAt) return;
  await appDb
    .update(monetizationConsumers)
    .set({ suspendedAt: null, suspendedReason: null, updatedAt: nowIso() })
    .where(eq(monetizationConsumers.id, consumerId));
  await refreshConsumer(consumerId);
  await logAuditEvent({
    userId: actorUserId,
    action: "resume",
    entityType: "monetization_consumer",
    entityId: consumerId,
    summary: `Resumed suspended API consumer ${row.name}`,
    data: { reason: row.suspendedReason },
  });
}

// ── Charges ──────────────────────────────────────────────────────────

const REASON_LABELS: Record<string, string> = {
  threshold: "usage reached the charge threshold",
  period: "end of the billing period",
  expiry: "before the card expires",
  manual: "charged by an administrator",
};

/**
 * Charges the consumer's saved card for its open amount (less charges on
 * their way), at most one charge at a time per consumer on any node. Skips
 * consumers that are not postpaid, have no usable card, are suspended, or
 * owe less than Stripe's minimum. Never checks the license.
 */
export async function chargeOpenAmount(consumerId: number, reason: ChargeReason, options: { period?: string; now?: number } = {}): Promise<ChargeOutcome> {
  return await withClusterLock(`monetization-charge:${consumerId}`, async () => {
    const now = options.now ?? Date.now();
    const row = await readConsumer(consumerId);
    if (!row) return { status: "skipped", reason: "unknown consumer" };
    const plan = await readPlan(row.planId);
    if (effectiveBilling(row, plan) !== "postpaid") return { status: "skipped", reason: "not postpaid" };
    if (row.status !== "active" && reason !== "manual" && reason !== "billing_switch") return { status: "skipped", reason: "disabled" };
    // A switch away from postpaid suspends the consumer while it charges (switchBilling).
    const suspension = readSuspension(row);
    if (suspension && !(suspension === "billing_switch" && reason === "billing_switch")) return { status: "skipped", reason: "suspended" };
    if (!row.paymentMethodId || !row.stripeCustomerId) return { status: "skipped", reason: "no card" };
    if (isCardExpired(row.cardExpMonth, row.cardExpYear, now)) return { status: "skipped", reason: "card expired" };
    const context = await stripeContext().catch(() => null);
    if (!context) return { status: "skipped", reason: "payments not configured" };
    const pending = (await pendingChargeTotals([row.id])).get(row.id) ?? 0;
    const amount = chargeableMicros(-(await liveBalance(row)), pending, context.currency);
    if (amount <= 0) return { status: "skipped", reason: "nothing to charge" };
    if (amount < minimumChargeMicros(context.currency)) return { status: "skipped", reason: "below the minimum charge" };
    const stamp = new Date(now).toISOString();
    const payment = (await first(appDb
      .insert(monetizationPayments)
      .values({
        consumerId: row.id,
        kind: "charge",
        reason,
        status: "pending",
        amountMicros: amount,
        currency: context.currency,
        period: options.period ?? null,
        idempotencyKey: `ingressi-${context.installId}-charge-${randomUUID()}`,
        paymentMethodId: row.paymentMethodId,
        createdAt: stamp,
        updatedAt: stamp,
      })
      .returning()))!;
    return await sendCharge(payment, row, context);
  });
}

/** Sends (or sends again, with the same idempotency key) a charge row to Stripe and applies the answer. */
async function sendCharge(payment: PaymentRow, row: Pick<ConsumerRow, "id" | "name" | "stripeCustomerId">, context: StripeContext): Promise<ChargeOutcome> {
  const minor = microsToMinor(payment.amountMicros, payment.currency);
  if (minor === null || !row.stripeCustomerId || !payment.paymentMethodId || !payment.idempotencyKey) {
    await markChargeFailed(payment, null, "invalid_charge", null);
    return { status: "failed", paymentId: payment.id, amountMicros: payment.amountMicros, code: "invalid_charge" };
  }
  const params = new URLSearchParams();
  params.set("amount", String(minor));
  params.set("currency", payment.currency);
  params.set("customer", row.stripeCustomerId);
  params.set("payment_method", payment.paymentMethodId);
  params.set("off_session", "true");
  params.set("confirm", "true");
  params.set("description", "API usage");
  params.set("metadata[ingressi_install]", context.installId);
  params.set("metadata[ingressi_consumer_id]", String(payment.consumerId));
  params.set("metadata[ingressi_charge_id]", String(payment.id));
  params.set("metadata[ingressi_kind]", "postpaid_charge");
  let reply: StripeReply;
  try {
    reply = await stripeRequest(context.secretKey, "POST", "/v1/payment_intents", { params, idempotencyKey: payment.idempotencyKey });
  } catch {
    // No answer: the charge stays pending (counted as on its way) and is sent again with the same key.
    return { status: "pending", paymentId: payment.id, amountMicros: payment.amountMicros };
  }
  if (reply.status === 401 || reply.status === 403) {
    // Our key, not the consumer's card: Stripe never processed the charge. It waits (pending, still
    // counted as on its way) and is sent again once the key works; nobody is suspended.
    await appDb
      .update(monetizationPayments)
      .set({ failureCode: STRIPE_KEY_REJECTED, updatedAt: nowIso() })
      .where(and(eq(monetizationPayments.id, payment.id), eq(monetizationPayments.status, "pending")));
    await noteStripeKeyRejected(reply.status);
    return { status: "pending", paymentId: payment.id, amountMicros: payment.amountMicros };
  }
  await clearStripeKeyRejection();
  return await applyChargeReply(payment, reply);
}

async function applyChargeReply(payment: PaymentRow, reply: StripeReply): Promise<ChargeOutcome> {
  const base = { paymentId: payment.id, amountMicros: payment.amountMicros };
  if (reply.ok) return await applyPaymentIntent(payment, reply.data);
  const intentId = stripeId(reply.error.paymentIntent?.id, ID_PATTERNS.paymentIntent);
  // An outage, a rate limit or a request still being processed: unknown, try again later with the same key.
  if (reply.status === 409 || reply.status === 429 || reply.status >= 500) return { status: "pending", ...base };
  const code = reply.error.code ?? reply.error.declineCode ?? "payment_failed";
  if (code === "amount_too_small") {
    // Stripe's minimum: the amount stays open for the next charge, nothing is suspended.
    await markChargeFailed(payment, intentId, code, null);
    return { status: "failed", ...base, code };
  }
  if (code === "idempotency_error") {
    // The key was used with other parameters: never resend; reconciliation looks the charge up.
    console.warn(`[monetization] Charge ${payment.id} could not be sent again with its idempotency key; it is reconciled by its metadata`);
    return { status: "pending", ...base };
  }
  await markChargeFailed(payment, intentId, code, code === "authentication_required" ? "authentication_required" : "payment_failed");
  return { status: "failed", ...base, code };
}

/** Applies a PaymentIntent of a charge row: succeeded, failed, or still on its way. */
async function applyPaymentIntent(payment: PaymentRow, intent: Record<string, unknown>): Promise<ChargeOutcome> {
  const base = { paymentId: payment.id, amountMicros: payment.amountMicros };
  const intentId = stripeId(intent.id, ID_PATTERNS.paymentIntent);
  if (!intentId) return { status: "pending", ...base };
  switch (intent.status) {
    case "succeeded": {
      const credited = await markChargeSucceeded(payment, intentId, intent);
      return credited ? { status: "succeeded", ...base } : { status: "pending", ...base };
    }
    case "processing":
      await appDb
        .update(monetizationPayments)
        .set({ paymentIntentId: intentId, updatedAt: nowIso() })
        .where(and(eq(monetizationPayments.id, payment.id), eq(monetizationPayments.status, "pending")));
      return { status: "pending", ...base };
    case "requires_action":
    case "requires_confirmation":
      await markChargeFailed(payment, intentId, "authentication_required", "authentication_required");
      return { status: "failed", ...base, code: "authentication_required" };
    default: {
      const lastError = typeof intent.last_payment_error === "object" && intent.last_payment_error !== null ? (intent.last_payment_error as Record<string, unknown>) : {};
      const code = typeof lastError.code === "string" && /^[a-z0-9_]{1,64}$/.test(lastError.code) ? lastError.code : intent.status === "canceled" ? "canceled" : "payment_failed";
      await markChargeFailed(payment, intentId, code, code === "authentication_required" ? "authentication_required" : "payment_failed");
      return { status: "failed", ...base, code };
    }
  }
}

/**
 * A charge succeeded: the amount Stripe received is credited once (ledger
 * reference "stripe-pi:<PaymentIntent>"), the row is marked, and a payment
 * suspension ends. False when the PaymentIntent does not match the row.
 */
async function markChargeSucceeded(payment: PaymentRow, intentId: string, intent: Record<string, unknown>): Promise<boolean> {
  const currency = typeof intent.currency === "string" ? intent.currency.toLowerCase() : null;
  if (currency !== payment.currency) {
    console.warn(`[monetization] Charge ${payment.id}: the PaymentIntent is in another currency; not credited`);
    return false;
  }
  const received = typeof intent.amount_received === "number" && Number.isSafeInteger(intent.amount_received) ? minorToMicros(intent.amount_received, currency) : null;
  const amount = received !== null && received > 0 && received <= MAX_AMOUNT_MICROS ? received : payment.amountMicros;
  const store = await monetizationBalanceStore();
  const result = await store.credit({
    consumerId: payment.consumerId,
    type: "payment",
    amountMicros: amount,
    reference: `stripe-pi:${intentId}`,
    description: `Card charged: ${REASON_LABELS[payment.reason ?? ""] ?? "postpaid usage"}`,
    createdBy: null,
  });
  if (result.status === "unknown_consumer") {
    await appDb.update(monetizationPayments).set({ status: "succeeded", paymentIntentId: intentId, updatedAt: nowIso() }).where(eq(monetizationPayments.id, payment.id));
    return true;
  }
  const updated = await appDb
    .update(monetizationPayments)
    .set({
      status: "succeeded",
      paymentIntentId: intentId,
      failureCode: null,
      ledgerId: result.status === "applied" ? result.entry?.id ?? null : payment.ledgerId,
      updatedAt: nowIso(),
    })
    .where(and(eq(monetizationPayments.id, payment.id), sql`${monetizationPayments.status} <> 'succeeded'`))
    .returning({ id: monetizationPayments.id });
  if (updated.length > 0) {
    await logAuditEvent({
      userId: null,
      action: "charge",
      entityType: "monetization_consumer",
      entityId: payment.consumerId,
      summary: `Charged ${formatMicros(amount, payment.currency)} to the saved card of API consumer ${payment.consumerId}`,
      data: { paymentId: payment.id, amountMicros: amount, reason: payment.reason },
    });
  }
  await clearPaymentSuspension(payment.consumerId);
  return true;
}

async function markChargeFailed(payment: PaymentRow, intentId: string | null, code: string, suspend: SuspensionReason | null): Promise<void> {
  const updated = await appDb
    .update(monetizationPayments)
    .set({
      status: suspend === "authentication_required" ? "requires_action" : "failed",
      failureCode: code.slice(0, 64),
      ...(intentId ? { paymentIntentId: intentId } : {}),
      updatedAt: nowIso(),
    })
    .where(and(eq(monetizationPayments.id, payment.id), eq(monetizationPayments.status, "pending")))
    .returning({ id: monetizationPayments.id });
  if (updated.length === 0) return;
  console.warn(`[monetization] A charge of API consumer ${payment.consumerId} failed (${code.slice(0, 64)})`);
  if (suspend) {
    await suspendConsumer(
      payment.consumerId,
      suspend,
      suspend === "authentication_required" ? "the bank asked the card holder to confirm a charge" : `a charge of the saved card failed (${code.slice(0, 64)})`
    );
  } else {
    await logAuditEvent({
      userId: null,
      action: "charge_failed",
      entityType: "monetization_consumer",
      entityId: payment.consumerId,
      summary: `A charge of API consumer ${payment.consumerId} was not made (${code.slice(0, 64)})`,
      data: { paymentId: payment.id },
    });
  }
}

/**
 * payment_intent.succeeded and payment_intent.payment_failed of a charge
 * this install made (metadata.ingressi_charge_id): applied once, whichever
 * of the API's answer and the webhook comes first.
 */
export async function handleChargeIntentEvent(intent: Record<string, unknown>): Promise<{ handled: boolean; reason?: string }> {
  const metadata = (typeof intent.metadata === "object" && intent.metadata !== null ? intent.metadata : {}) as Record<string, unknown>;
  const installId = (await ensureGateSecret()).installId;
  if (metadata.ingressi_install !== installId) return { handled: false, reason: "payment of another install or product" };
  const chargeId = Number(metadata.ingressi_charge_id);
  if (!Number.isSafeInteger(chargeId) || chargeId < 1) return { handled: false, reason: "not a postpaid charge" };
  const payment = await first(appDb.select().from(monetizationPayments).where(eq(monetizationPayments.id, chargeId)).limit(1));
  if (!payment || payment.kind !== "charge") return { handled: false, reason: "unknown charge" };
  if (String(payment.consumerId) !== String(metadata.ingressi_consumer_id)) return { handled: false, reason: "consumer mismatch" };
  const intentId = stripeId(intent.id, ID_PATTERNS.paymentIntent);
  if (!intentId || (payment.paymentIntentId && payment.paymentIntentId !== intentId)) return { handled: false, reason: "payment intent mismatch" };
  if (payment.status === "succeeded") return { handled: true };
  if (intent.status !== "succeeded" && payment.status !== "pending") return { handled: true };
  await withClusterLock(`monetization-charge:${payment.consumerId}`, async () => {
    const current = (await first(appDb.select().from(monetizationPayments).where(eq(monetizationPayments.id, chargeId)).limit(1)))!;
    await applyPaymentIntent(current, intent);
  });
  return { handled: true };
}

/** Looks a charge up in Stripe by its metadata (after the idempotency window), or null. */
async function findChargeIntent(context: StripeContext, payment: PaymentRow): Promise<Record<string, unknown> | null | "unavailable"> {
  const query = `metadata['ingressi_charge_id']:'${payment.id}' AND metadata['ingressi_install']:'${context.installId}'`;
  let reply: StripeReply;
  try {
    reply = await stripeRequest(context.secretKey, "GET", "/v1/payment_intents/search", { params: new URLSearchParams([["query", query]]) });
  } catch {
    return "unavailable";
  }
  if (!reply.ok) return "unavailable";
  const data = Array.isArray(reply.data.data) ? reply.data.data : [];
  const match = data.find((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
  return match ?? null;
}

/**
 * Brings charges whose outcome is not known up to date: by their
 * PaymentIntent when Stripe answered before, by sending them again with the
 * same idempotency key within Stripe's 24 hours (Stripe answers with the
 * first outcome and charges once), and by their metadata after that. Runs at
 * start and every few minutes on the leader. Never checks the license.
 */
export async function reconcilePendingCharges(now: number = Date.now()): Promise<{ checked: number }> {
  const cutoff = new Date(now - RECONCILE_AFTER_MS).toISOString();
  const rows = await appDb
    .select()
    .from(monetizationPayments)
    .where(and(eq(monetizationPayments.kind, "charge"), eq(monetizationPayments.status, "pending"), lt(monetizationPayments.updatedAt, cutoff)))
    .limit(100);
  if (rows.length === 0) return { checked: 0 };
  const context = await stripeContext().catch(() => null);
  if (!context) return { checked: 0 };
  let checked = 0;
  for (const payment of rows) {
    await withClusterLock(`monetization-charge:${payment.consumerId}`, async () => {
      const current = await first(appDb.select().from(monetizationPayments).where(eq(monetizationPayments.id, payment.id)).limit(1));
      if (!current || current.status !== "pending") return;
      checked += 1;
      if (current.paymentIntentId) {
        const reply = await stripeRequest(context.secretKey, "GET", `/v1/payment_intents/${current.paymentIntentId}`).catch(() => null);
        if (reply?.ok) await applyPaymentIntent(current, reply.data);
        return;
      }
      if (current.failureCode === STRIPE_KEY_REJECTED) {
        // Stripe refused our key before reading it: nothing was charged, so it is sent again whatever its age.
        // From now on its answer counts as any other's (a lost one is replayed or looked up).
        const reset = { ...current, failureCode: null, updatedAt: nowIso() };
        await appDb.update(monetizationPayments).set({ failureCode: null, updatedAt: reset.updatedAt }).where(eq(monetizationPayments.id, current.id));
        const consumer = await readConsumer(current.consumerId);
        await sendCharge(reset, { id: current.consumerId, name: consumer?.name ?? "", stripeCustomerId: consumer?.stripeCustomerId ?? null }, context);
        return;
      }
      if (now - Date.parse(current.createdAt) < REPLAY_WINDOW_MS) {
        const consumer = await readConsumer(current.consumerId);
        await sendCharge(current, { id: current.consumerId, name: consumer?.name ?? "", stripeCustomerId: consumer?.stripeCustomerId ?? null }, context);
        return;
      }
      const found = await findChargeIntent(context, current);
      if (found === "unavailable") return;
      if (found) await applyPaymentIntent(current, found);
      else await markChargeFailed(current, null, "not_sent", null);
    });
  }
  return { checked };
}

/**
 * One pass of postpaid billing (the leader, every minute): for every active
 * postpaid consumer with a usable card that is not suspended, charge the
 * open amount at the end of a billing period (once per period), when it
 * reaches the plan's threshold, and before the card expires. Never checks
 * the license.
 */
export async function runPostpaidBilling(now: number = Date.now()): Promise<{ charged: number }> {
  let charged = 0;
  const result = await tryWithClusterLock("monetization-billing", async () => {
    const stored = await readStoredPayments();
    if (!(await readStripeSecrets(stored)).secretKey) return;
    const currency = await readCurrency(stored);
    const plans = new Map((await appDb.select().from(monetizationPlans)).map((plan) => [plan.id, plan]));
    const rows = (await appDb
      .select()
      .from(monetizationConsumers)
      .where(and(eq(monetizationConsumers.status, "active"), isNull(monetizationConsumers.suspendedAt))))
      .filter((row) => effectiveBilling(row, row.planId === null ? null : plans.get(row.planId)) === "postpaid");
    if (rows.length === 0) return;
    const counters = await (await monetizationBalanceStore()).liveCounters(rows);
    const pending = await pendingChargeTotals(rows.map((row) => row.id));
    const period = previousPeriod(now);
    for (const row of rows) {
      const plan = row.planId === null ? undefined : plans.get(row.planId);
      if (!plan?.postpaidCapMicros || !row.paymentMethodId) continue;
      const open = -(counters.get(row.id)?.balanceMicros ?? row.balanceMicros);
      const chargeable = chargeableMicros(open, pending.get(row.id) ?? 0, currency);
      let reason: ChargeReason | null = null;
      if (row.billedPeriod === null || row.billedPeriod < period) {
        reason = "period";
        // Once per period, whatever the charge's outcome (a failure suspends; an outage is reconciled).
        await appDb.update(monetizationConsumers).set({ billedPeriod: period }).where(eq(monetizationConsumers.id, row.id));
      } else if (chargeable >= effectiveThreshold(plan.postpaidCapMicros, plan.postpaidThresholdMicros)) {
        reason = "threshold";
      } else {
        const expiresAt = cardExpiresAt(row.cardExpMonth, row.cardExpYear);
        if (expiresAt !== null && expiresAt - now <= EXPIRY_CHARGE_WINDOW_MS && expiresAt > now) reason = "expiry";
      }
      if (!reason || chargeable < minimumChargeMicros(currency)) continue;
      try {
        const outcome = await chargeOpenAmount(row.id, reason, { period: reason === "period" ? period : undefined, now });
        if (outcome.status === "succeeded" || outcome.status === "pending") charged += 1;
      } catch (error) {
        console.error(`[monetization] Charging API consumer ${row.id} failed:`, error instanceof Error ? error.name : typeof error);
      }
    }
  });
  if (!result.acquired) return { charged: 0 };
  return { charged };
}

/** The ids of consumers whose charges may need reconciling (tests). */
export async function pendingChargeIds(): Promise<number[]> {
  return (await appDb.select({ id: monetizationPayments.id }).from(monetizationPayments).where(eq(monetizationPayments.status, "pending"))).map((row) => row.id);
}

/** Records the outcome of an open amount paid in Checkout: credited by the caller; ends a payment suspension and saves the card. */
export async function afterOpenAmountPaid(consumerId: number, paymentIntentId: string | null): Promise<void> {
  await clearPaymentSuspension(consumerId);
  if (paymentIntentId) {
    await saveCardFromPaymentIntent(paymentIntentId, consumerId).catch(() => null);
  }
}

/** Charges the open amount now (an administrator). Needs no license: it collects what is owed. */
export async function chargeNow(consumerId: number, actorUserId: number): Promise<ChargeOutcome> {
  const row = await readConsumer(consumerId);
  if (!row) throw new ApiClientError("Consumer not found", 404);
  const outcome = await chargeOpenAmount(consumerId, "manual");
  await logAuditEvent({
    userId: actorUserId,
    action: "charge_now",
    entityType: "monetization_consumer",
    entityId: consumerId,
    summary: `Asked to charge the open amount of API consumer ${row.name}`,
    data: { outcome: outcome.status, ...(outcome.status === "skipped" ? { reason: outcome.reason } : { amountMicros: outcome.amountMicros }) },
  });
  return outcome;
}
