// SPDX-License-Identifier: Elastic-2.0
/**
 * Stripe payments through the customer's own Stripe account. Ingressi never
 * holds money: it creates Checkout Sessions with the customer's secret key
 * (top-ups; for postpaid consumers, saving a card and paying an open amount,
 * see postpaid.ts), and credits a consumer's balance when Stripe's signed
 * webhook reports a payment.
 *
 *  - Settings: the secret key and webhook signing secret are stored with
 *    encryptSecret and never returned (hasSecretKey / hasWebhookSecret).
 *  - Webhook: the Stripe-Signature header is verified on the raw body
 *    (HMAC-SHA256 of "<t>.<body>" with the signing secret, any v1 signature,
 *    timestamp within five minutes), as Stripe documents for manual
 *    verification. Only sessions carrying this install's id in their metadata
 *    are credited, once each (ledger reference "stripe:<session id>").
 *
 * Licensing: saving the settings needs "api_monetization"; removing them
 * never does. Creating sessions and crediting payments never check it.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { ID_PATTERNS, PaymentProviderError, STRIPE_API_BASE, stripeId, stripeRequest, type StripeReply } from "./stripe-api";
import { applyDispute, applyRefund, consumerExists, NOT_RECORDED, recordCheckoutPayment } from "./stripe-payments";
import {
  afterOpenAmountPaid,
  applyAutomaticTax,
  handleChargeIntentEvent,
  saveCardFromSetupIntent,
  suspendConsumer,
} from "./postpaid";
import { ne } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { monetizationConsumers } from "@/src/lib/db/schema";
import { logAuditEvent } from "@/src/lib/audit";
import { config } from "@/src/lib/config";
import { encryptSecret } from "@/src/lib/secret";
import { ApiConflictError, ApiValidationError } from "@/src/lib/api-errors";
import { requireFeature } from "@/ee/licensing/store";
import { reloadMonetization } from "./engine";
import { monetizationBalanceStore } from "./balance-store";
import { formatMicros, isCurrencyCode, microsToMinor, minorToMicros, MAX_AMOUNT_MICROS } from "./money";
import { parseInteger, rejectUnknownKeys, requireRecord } from "./http";
import {
  ensureGateSecret,
  PAYMENTS_SETTING_KEY,
  readCurrency,
  readGateSecret,
  readStoredPayments,
  readStripeSecrets,
  writeSettingRow,
  type StoredPayments,
} from "./settings";
import { FEATURE, STRIPE_WEBHOOK_EVENTS, WEBHOOK_PATH, type StripeSettingsView } from "./types";
import { clearStripeKeyRejection } from "./stripe-status";
import { detachX402FromStripe } from "./x402/settings";
import { first } from "@/src/lib/db/ops";

export { PaymentProviderError, STRIPE_API_BASE };
/** How old a webhook signature may be (Stripe's libraries default to 300 s). */
export const WEBHOOK_TOLERANCE_SECONDS = 300;
const MAX_TOP_UP_AMOUNTS = 10;
const SECRET_KEY = /^(?:sk|rk)_(live|test)_[A-Za-z0-9]{8,256}$/;
const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/=_-]{8,256}$/;

// ── Settings ─────────────────────────────────────────────────────────

function modeOf(secretKey: string | null): "live" | "test" | null {
  return secretKey ? SECRET_KEY.exec(secretKey)?.[1] === "live" ? "live" : "test" : null;
}

export async function getStripeSettingsView(given?: StoredPayments): Promise<StripeSettingsView> {
  const stored = given ?? (await readStoredPayments());
  const secrets = await readStripeSecrets(stored);
  return {
    configured: Boolean(secrets.secretKey && secrets.webhookSecret),
    hasSecretKey: Boolean(stored.secretKey),
    hasWebhookSecret: Boolean(stored.webhookSecret),
    mode: modeOf(secrets.secretKey),
    currency: await readCurrency(stored),
    topUpAmountsMicros: Array.isArray(stored.topUpAmountsMicros) ? stored.topUpAmountsMicros.filter((n) => Number.isSafeInteger(n) && n > 0) : [],
    topUpUrl: typeof stored.topUpUrl === "string" && stored.topUpUrl ? stored.topUpUrl : null,
    webhookUrl: `${config.baseUrl}${WEBHOOK_PATH}`,
    webhookEvents: [...STRIPE_WEBHOOK_EVENTS],
    automaticTax: stored.automaticTax === true,
  };
}

function parseSecret(value: unknown, field: string, pattern: RegExp, hint: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !pattern.test(value.trim())) throw new ApiValidationError(`${field} must be ${hint}`);
  return value.trim();
}

function parseTopUpUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 2048) throw new ApiValidationError("topUpUrl must be an https URL");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ApiValidationError("topUpUrl must be an https URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) throw new ApiValidationError("topUpUrl must be an https URL");
  return url.toString();
}

function parseTopUpAmounts(value: unknown, currency: string): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TOP_UP_AMOUNTS) {
    throw new ApiValidationError(`topUpAmountsMicros must list 1 to ${MAX_TOP_UP_AMOUNTS} amounts`);
  }
  const amounts = value.map((amount) => {
    const micros = parseInteger(amount, "topUpAmountsMicros", 1, MAX_AMOUNT_MICROS);
    if (microsToMinor(micros, currency) === null) {
      throw new ApiValidationError(`Every top-up amount must be a whole number of the smallest ${currency.toUpperCase()} unit`);
    }
    return micros;
  });
  return [...new Set(amounts)].sort((a, b) => a - b);
}

/**
 * {secretKey?, webhookSecret?, currency?, topUpAmountsMicros?, topUpUrl?, automaticTax?}.
 * Omitted or empty secrets keep the stored ones. The currency cannot change
 * while any consumer has a non-zero balance (balances and prices are in it).
 */
export async function saveStripeSettings(body: unknown, actorUserId: number): Promise<StripeSettingsView> {
  await requireFeature(FEATURE);
  const record = requireRecord(body);
  rejectUnknownKeys(record, ["secretKey", "webhookSecret", "currency", "topUpAmountsMicros", "topUpUrl", "automaticTax"]);
  const stored = await readStoredPayments();
  const secretKey = parseSecret(record.secretKey, "secretKey", SECRET_KEY, "a Stripe secret or restricted key (sk_live_…, sk_test_…, rk_…)");
  const webhookSecret = parseSecret(record.webhookSecret, "webhookSecret", WEBHOOK_SECRET, "a webhook signing secret (whsec_…)");
  const previousCurrency = await readCurrency(stored);
  let currency = previousCurrency;
  if (record.currency !== undefined) {
    const code = typeof record.currency === "string" ? record.currency.trim().toLowerCase() : "";
    if (!isCurrencyCode(code)) throw new ApiValidationError("currency must be a three-letter ISO 4217 code such as usd or eur");
    currency = code;
  }
  const assertCurrencyChangeable = async () => {
    if (currency === previousCurrency) return;
    const funded = await first(appDb.select({ id: monetizationConsumers.id }).from(monetizationConsumers).where(ne(monetizationConsumers.balanceMicros, 0)).limit(1));
    if (funded) {
      throw new ApiConflictError("The currency cannot change while consumers have a non-zero balance; it is the unit of every balance and price");
    }
  };
  await assertCurrencyChangeable();
  const topUpAmountsMicros =
    record.topUpAmountsMicros === undefined
      ? (stored.topUpAmountsMicros ?? []).filter((micros) => microsToMinor(micros, currency) !== null)
      : parseTopUpAmounts(record.topUpAmountsMicros, currency);
  const topUpUrl = record.topUpUrl === undefined ? stored.topUpUrl ?? null : parseTopUpUrl(record.topUpUrl);
  if (record.automaticTax !== undefined && typeof record.automaticTax !== "boolean") throw new ApiValidationError("automaticTax must be true or false");
  const automaticTax = record.automaticTax === undefined ? stored.automaticTax === true : record.automaticTax;

  const next: StoredPayments = {
    ...(secretKey ? { secretKey: encryptSecret(secretKey) } : stored.secretKey ? { secretKey: stored.secretKey } : {}),
    ...(webhookSecret ? { webhookSecret: encryptSecret(webhookSecret) } : stored.webhookSecret ? { webhookSecret: stored.webhookSecret } : {}),
    currency,
    topUpAmountsMicros,
    topUpUrl,
    automaticTax,
  };
  // Another key than the stored one (possibly another account or mode): x402's deposit address belonged to the old one.
  const keyReplaced = Boolean(secretKey && secretKey !== (await readStripeSecrets(stored)).secretKey);
  // Checked again with the write, in one transaction: no balance appears in between.
  await appDb.transaction(async () => {
    await assertCurrencyChangeable();
    await writeSettingRow(PAYMENTS_SETTING_KEY, next);
  });
  // A new key gets a new chance: a note that Stripe refused the old one goes.
  if (secretKey) await clearStripeKeyRejection();
  const x402TurnedOff = keyReplaced ? await detachX402FromStripe(actorUserId, "key_replaced") : false;
  await ensureGateSecret();
  await reloadMonetization();
  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "monetization_stripe",
    summary: "Updated the Stripe settings of API monetization",
    data: {
      secretKeyChanged: Boolean(secretKey),
      webhookSecretChanged: Boolean(webhookSecret),
      currency,
      topUpAmountsMicros,
      topUpUrl,
      automaticTax,
      ...(x402TurnedOff ? { x402TurnedOff } : {}),
    },
  });
  return { ...(await getStripeSettingsView(next)), ...(x402TurnedOff ? { x402TurnedOff } : {}) };
}

/**
 * Removes the Stripe secrets (top-ups stop; balances and metering are
 * unaffected). The currency and amounts are kept. Never needs a license.
 */
export async function removeStripeSettings(actorUserId: number): Promise<StripeSettingsView> {
  const stored = await readStoredPayments();
  const next: StoredPayments = {
    currency: await readCurrency(stored),
    topUpAmountsMicros: stored.topUpAmountsMicros ?? [],
    topUpUrl: stored.topUpUrl ?? null,
    automaticTax: stored.automaticTax === true,
  };
  await writeSettingRow(PAYMENTS_SETTING_KEY, next);
  await clearStripeKeyRejection();
  const x402TurnedOff = stored.secretKey ? await detachX402FromStripe(actorUserId, "key_removed") : false;
  await reloadMonetization();
  await logAuditEvent({
    userId: actorUserId,
    action: "delete",
    entityType: "monetization_stripe",
    summary: "Removed the Stripe keys of API monetization",
    ...(x402TurnedOff ? { data: { x402TurnedOff } } : {}),
  });
  return { ...(await getStripeSettingsView(next)), ...(x402TurnedOff ? { x402TurnedOff } : {}) };
}

// ── Checkout ─────────────────────────────────────────────────────────

export type CheckoutConsumer = { id: number; name: string; email: string | null };

/**
 * Creates a Stripe Checkout Session for a top-up of `amountMicros` (one of the
 * configured amounts) and returns its URL. Never checks the license.
 */
export async function createTopUpCheckout(
  consumer: CheckoutConsumer,
  amountMicros: number,
  urls: { successUrl: string; cancelUrl: string }
): Promise<string> {
  const stored = await readStoredPayments();
  const view = await getStripeSettingsView(stored);
  const { secretKey } = await readStripeSecrets(stored);
  if (!view.configured || !secretKey) throw new ApiConflictError("Top-ups are not available yet");
  if (!view.topUpAmountsMicros.includes(amountMicros)) throw new ApiValidationError("Choose one of the offered top-up amounts");
  const currency = view.currency;
  const unitAmount = microsToMinor(amountMicros, currency);
  if (unitAmount === null) throw new ApiValidationError("Choose one of the offered top-up amounts");
  const installId = (await ensureGateSecret()).installId;

  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", urls.successUrl);
  form.set("cancel_url", urls.cancelUrl);
  form.set("client_reference_id", `ingressi-consumer-${consumer.id}`);
  form.set("line_items[0][quantity]", "1");
  form.set("line_items[0][price_data][currency]", currency);
  form.set("line_items[0][price_data][unit_amount]", String(unitAmount));
  form.set("line_items[0][price_data][product_data][name]", `API credit (${formatMicros(amountMicros, currency)})`);
  form.set("metadata[ingressi_install]", installId);
  form.set("metadata[ingressi_consumer_id]", String(consumer.id));
  form.set("payment_intent_data[metadata][ingressi_install]", installId);
  form.set("payment_intent_data[metadata][ingressi_consumer_id]", String(consumer.id));
  if (consumer.email) form.set("customer_email", consumer.email);
  // Stripe Tax (the operator's option): tax on top of the amount; the amount is what is credited.
  if (stored.automaticTax === true) applyAutomaticTax(form, false);

  let response: Response;
  try {
    response = await fetch(`${STRIPE_API_BASE}/v1/checkout/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": randomUUID(),
      },
      body: form.toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new PaymentProviderError("Stripe could not be reached");
  }
  let data: { url?: unknown; error?: { type?: unknown; code?: unknown } } = {};
  try {
    data = (await response.json()) as typeof data;
  } catch {
    // handled below
  }
  if (!response.ok || typeof data.url !== "string" || !data.url.startsWith("https://")) {
    const code = typeof data.error?.code === "string" && /^[a-z_]{1,64}$/.test(data.error.code) ? ` (${data.error.code})` : "";
    console.warn(`[monetization] Stripe refused a checkout session: HTTP ${response.status}${code}`);
    throw new PaymentProviderError(`Stripe did not create the checkout session${code}`);
  }
  return data.url;
}

// ── Webhook ──────────────────────────────────────────────────────────

/**
 * Verifies a Stripe-Signature header ("t=<unix>,v1=<hex>[,v1=…][,v0=…]") for
 * the raw body: HMAC-SHA256 with the signing secret over "<t>.<body>",
 * compared in constant time with every v1 value; the timestamp must be within
 * the tolerance.
 */
export function verifyStripeSignature(
  rawBody: Buffer,
  header: string | null,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds: number = WEBHOOK_TOLERANCE_SECONDS
): boolean {
  if (!header || header.length > 4096 || !secret) return false;
  let timestamp: number | null = null;
  const signatures: Buffer[] = [];
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t" && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    if (key === "v1" && /^[a-f0-9]{64}$/.test(value)) signatures.push(Buffer.from(value, "hex"));
  }
  if (timestamp === null || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest();
  let match = false;
  for (const signature of signatures) {
    if (signature.length === expected.length && timingSafeEqual(signature, expected)) match = true;
  }
  return match;
}

export type WebhookOutcome =
  | { handled: false; reason: string; retry?: boolean }
  | { handled: true; consumerId: number; amountMicros: number; duplicate: boolean };

type CheckoutSession = {
  id?: unknown;
  mode?: unknown;
  payment_status?: unknown;
  amount_total?: unknown;
  amount_subtotal?: unknown;
  currency?: unknown;
  payment_intent?: unknown;
  setup_intent?: unknown;
  metadata?: Record<string, unknown> | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Applies a verified Stripe event; anything this install did not start is
 * acknowledged and ignored. Every event is idempotent: Stripe retries and
 * sends some outcomes twice (a checkout session and its PaymentIntent).
 *
 *  - checkout.session.completed / async_payment_succeeded: a paid top-up or
 *    open amount is credited ("stripe:<session>"); a setup-mode session
 *    saves the card.
 *  - setup_intent.succeeded: saves the card.
 *  - payment_intent.succeeded / payment_failed: the outcome of a postpaid
 *    charge (metadata.ingressi_charge_id).
 *  - charge.refunded / charge.dispute.created: the refunded or disputed
 *    amount comes off the balance; a dispute suspends the consumer.
 */
export async function handleStripeEvent(event: unknown): Promise<WebhookOutcome> {
  if (typeof event !== "object" || event === null) return { handled: false, reason: "not an event" };
  const { type, data } = event as { type?: unknown; data?: { object?: unknown } };
  if (!(STRIPE_WEBHOOK_EVENTS as readonly unknown[]).includes(type)) return { handled: false, reason: "event type not used" };
  const object = isRecord(data?.object) ? data.object : {};
  switch (type) {
    case "setup_intent.succeeded": {
      const outcome = await saveCardFromSetupIntent(object);
      return outcome.handled ? { handled: true, consumerId: outcome.consumerId, amountMicros: 0, duplicate: false } : outcome;
    }
    case "payment_intent.succeeded":
    case "payment_intent.payment_failed": {
      const outcome = await handleChargeIntentEvent(object);
      return outcome.handled ? { handled: true, consumerId: 0, amountMicros: 0, duplicate: false } : { handled: false, reason: outcome.reason ?? "ignored" };
    }
    case "charge.refunded":
      return await handleRefundEvent(object);
    case "charge.dispute.created":
      return await handleDisputeEvent(object);
    default:
      return await handleCheckoutEvent(object as CheckoutSession);
  }
}

/**
 * A refund or dispute can come before the checkout.session.completed of its
 * payment (Stripe does not order events), or for a top-up paid before
 * payments were recorded: its Checkout Session is looked up in Stripe by the
 * PaymentIntent and applied first, exactly as its own event would be (the
 * same ledger reference, so it is never credited twice). "unavailable":
 * Stripe could not be asked; the webhook answers 503 and Stripe sends the
 * event again.
 */
async function recordPaymentFromStripe(paymentIntentId: string): Promise<"recorded" | "not_ours" | "unavailable"> {
  const { secretKey } = await readStripeSecrets();
  if (!secretKey) return "unavailable";
  const params = new URLSearchParams({ payment_intent: paymentIntentId, limit: "1" });
  let reply: StripeReply;
  try {
    reply = await stripeRequest(secretKey, "GET", "/v1/checkout/sessions", { params });
  } catch {
    return "unavailable";
  }
  if (!reply.ok) return reply.status === 400 || reply.status === 404 ? "not_ours" : "unavailable";
  const sessions = Array.isArray(reply.data.data) ? reply.data.data : [];
  const session = sessions.find((item): item is CheckoutSession => isRecord(item) && item.payment_intent === paymentIntentId);
  if (!session) return "not_ours";
  const outcome = await handleCheckoutEvent(session);
  return outcome.handled ? "recorded" : "not_ours";
}

/** Runs `apply`; when the payment has no row here, records it from Stripe and runs it again. */
async function withPaymentRecorded<T extends { handled: boolean; reason?: string }>(
  paymentIntentId: string,
  apply: () => Promise<T>
): Promise<T | { handled: false; reason: string; retry: true }> {
  const outcome = await apply();
  if (outcome.handled || outcome.reason !== NOT_RECORDED) return outcome;
  const recorded = await recordPaymentFromStripe(paymentIntentId);
  if (recorded === "unavailable") return { handled: false, reason: "payment not found yet; Stripe could not be asked", retry: true };
  return recorded === "recorded" ? await apply() : outcome;
}

async function handleRefundEvent(charge: Record<string, unknown>): Promise<WebhookOutcome> {
  const chargeId = stripeId(charge.id, ID_PATTERNS.charge);
  const paymentIntentId = stripeId(charge.payment_intent, ID_PATTERNS.paymentIntent);
  if (!chargeId || !paymentIntentId) return { handled: false, reason: "no payment" };
  if (typeof charge.amount_refunded !== "number" || !Number.isSafeInteger(charge.amount_refunded)) return { handled: false, reason: "no amount" };
  const currency = typeof charge.currency === "string" ? charge.currency.toLowerCase() : "";
  const refundedMinor = charge.amount_refunded;
  const result = await withPaymentRecorded(paymentIntentId, async () =>
    applyRefund(await monetizationBalanceStore(), { paymentIntentId, chargeId, refundedMinor, currency })
  );
  if ("retry" in result) return result;
  return result.handled ? { handled: true, consumerId: 0, amountMicros: -(result.amountMicros ?? 0), duplicate: result.amountMicros === 0 } : { handled: false, reason: result.reason ?? "ignored" };
}

async function handleDisputeEvent(dispute: Record<string, unknown>): Promise<WebhookOutcome> {
  const disputeId = stripeId(dispute.id, ID_PATTERNS.dispute);
  const paymentIntentId = stripeId(dispute.payment_intent, ID_PATTERNS.paymentIntent);
  if (!disputeId || !paymentIntentId) return { handled: false, reason: "no payment" };
  if (typeof dispute.amount !== "number" || !Number.isSafeInteger(dispute.amount)) return { handled: false, reason: "no amount" };
  const currency = typeof dispute.currency === "string" ? dispute.currency.toLowerCase() : "";
  const amountMinor = dispute.amount;
  const result = await withPaymentRecorded(paymentIntentId, async () =>
    applyDispute(await monetizationBalanceStore(), { paymentIntentId, disputeId, amountMinor, currency })
  );
  if ("retry" in result) return result;
  if (!result.handled || !result.consumerId) return { handled: false, reason: result.reason ?? "ignored" };
  await suspendConsumer(result.consumerId, "dispute", "a payment is disputed");
  return { handled: true, consumerId: result.consumerId, amountMicros: -(result.amountMicros ?? 0), duplicate: result.amountMicros === 0 };
}

async function handleCheckoutEvent(session: CheckoutSession): Promise<WebhookOutcome> {
  if (typeof session.id !== "string" || !/^cs_[A-Za-z0-9_]{1,250}$/.test(session.id)) return { handled: false, reason: "no checkout session" };
  if (session.mode === "setup") {
    const installId = (await readGateSecret())?.installId;
    if (!installId || session.metadata?.ingressi_install !== installId) return { handled: false, reason: "session of another install or product" };
    const setupIntent = stripeId(session.setup_intent, ID_PATTERNS.setupIntent);
    if (!setupIntent) return { handled: false, reason: "no setup intent" };
    const outcome = await saveCardFromSetupIntent(setupIntent);
    return outcome.handled ? { handled: true, consumerId: outcome.consumerId, amountMicros: 0, duplicate: false } : outcome;
  }
  if (session.mode !== "payment") return { handled: false, reason: "not a payment session" };
  if (session.payment_status !== "paid") return { handled: false, reason: "not paid yet" };
  const installId = (await readGateSecret())?.installId;
  if (!installId || session.metadata?.ingressi_install !== installId) {
    return { handled: false, reason: "session of another install or product" };
  }
  const consumerId = Number(session.metadata?.ingressi_consumer_id);
  if (!Number.isSafeInteger(consumerId) || consumerId < 1) return { handled: false, reason: "no consumer" };
  const currency = await readCurrency();
  if (typeof session.currency !== "string" || session.currency.toLowerCase() !== currency) {
    console.warn(`[monetization] Ignored a paid checkout session in another currency than ${currency}`);
    return { handled: false, reason: "currency mismatch" };
  }
  // The amount before tax: with Stripe Tax on, the tax goes on top and is not credited.
  const paid = typeof session.amount_subtotal === "number" && session.amount_subtotal > 0 ? session.amount_subtotal : session.amount_total;
  if (typeof paid !== "number" || !Number.isSafeInteger(paid) || paid <= 0) {
    return { handled: false, reason: "no amount" };
  }
  const amountMicros = minorToMicros(paid, currency);
  if (!Number.isSafeInteger(amountMicros) || amountMicros > MAX_AMOUNT_MICROS) return { handled: false, reason: "amount out of range" };
  const openAmount = session.metadata?.ingressi_kind === "open_amount";
  const paymentIntentId = stripeId(session.payment_intent, ID_PATTERNS.paymentIntent);

  const result = await (await monetizationBalanceStore()).credit({
    consumerId,
    type: openAmount ? "payment" : "topup",
    amountMicros,
    reference: `stripe:${session.id}`,
    description: openAmount ? "Open amount paid in Stripe Checkout" : "Stripe Checkout top-up",
    createdBy: null,
  });
  if (result.status === "unknown_consumer") {
    console.warn(`[monetization] A paid checkout session names consumer ${consumerId}, which no longer exists`);
    return { handled: false, reason: "unknown consumer" };
  }
  if (result.status === "applied") {
    await logAuditEvent({
      userId: null,
      action: openAmount ? "payment" : "topup",
      entityType: "monetization_consumer",
      entityId: consumerId,
      summary: openAmount
        ? `API consumer ${consumerId} paid ${formatMicros(amountMicros, currency)} of open usage through Stripe`
        : `API consumer ${consumerId} topped up ${formatMicros(amountMicros, currency)} through Stripe`,
      data: { amountMicros, reference: `stripe:${session.id}` },
    });
  }
  // The payment's PaymentIntent, so that a later refund or dispute finds the consumer.
  if (await consumerExists(consumerId)) {
    await recordCheckoutPayment({
      consumerId,
      kind: openAmount ? "open_amount" : "topup",
      amountMicros,
      currency,
      checkoutSessionId: session.id,
      paymentIntentId,
      ledgerId: result.status === "applied" ? result.entry?.id ?? null : null,
    });
  }
  if (openAmount) await afterOpenAmountPaid(consumerId, paymentIntentId);
  return { handled: true, consumerId, amountMicros, duplicate: result.status === "duplicate" };
}
