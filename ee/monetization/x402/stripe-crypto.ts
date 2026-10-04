// SPDX-License-Identifier: Elastic-2.0
/**
 * Stripe's side of x402 (docs.stripe.com/payments/machine/x402): the crypto
 * deposit address payments go to, and the PaymentIntent that records a
 * settled payment in the operator's Stripe balance. Both need Stripe's
 * preview API version and the "Stablecoins and Crypto" payment method, which
 * Stripe enables after a review (outside the US, on request to
 * machine-payments@stripe.com).
 *
 *  - POST /v1/crypto/deposit_addresses, network=base: once, when the
 *    operator turns x402 on (never on the request path). Stripe custodies
 *    what is paid to it.
 *  - POST /v1/payment_intents with confirm=true, the crypto payment method in
 *    transaction_verification mode on Base and the settlement's transaction
 *    hash, idempotency key = the hash: Stripe checks the transaction on chain
 *    against its deposit address and the amount, and the money lands in the
 *    operator's Stripe balance. Only a PaymentIntent that succeeded counts.
 *
 * Replies are untrusted (stripe-api.ts reads them); nothing here logs a key.
 */
import { createHash } from "node:crypto";
import { ID_PATTERNS, stripeId, stripeRequest, type StripeReply } from "../stripe-api";

/** The preview API version Stripe's x402 guide requires. */
export const STRIPE_CRYPTO_API_VERSION = "2026-05-27.preview";

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Stripe could not be asked (network, timeout, 5xx, 429, a request still in progress): try again later. */
export class StripeUnavailableError extends Error {
  constructor() {
    super("Stripe could not be reached");
    this.name = "StripeUnavailableError";
  }
}

/**
 * Whether a Stripe refusal means the crypto payment method is not enabled on
 * the account (not requested, pending review, or not available in its
 * country). Stripe documents no dedicated code for it, so this matches the
 * documented code for an unactivated payment method and, otherwise, a
 * refusal whose message names crypto or stablecoins as not activated.
 */
export function isCryptoNotEnabled(reply: Extract<StripeReply, { ok: false }>): boolean {
  if (reply.status >= 500 || reply.status === 429) return false;
  if (reply.error.code === "payment_method_unactivated" || reply.error.code === "payment_method_not_available") return true;
  const message = (reply.error.message ?? "").toLowerCase();
  return /crypto|stablecoin/.test(message) && /(not|isn't|is not|hasn't|has not)\b.*\b(activated|enabled|available|approved)|request access|activate/.test(message);
}

/** A live-mode Stripe key (sk_live_… or rk_live_…): x402 takes real payments on Base mainnet only. */
export function isLiveStripeKey(secretKey: string | null): boolean {
  return typeof secretKey === "string" && /^(?:sk|rk)_live_/.test(secretKey);
}

/**
 * A digest of the Stripe key a deposit address was created with: the address
 * is offered only while that key is the one set (a key of another account or
 * mode would record nothing). Not reversible; the key itself stays encrypted.
 */
export function stripeKeyFingerprint(secretKey: string): string {
  return createHash("sha256").update(`ingressi:x402-stripe-key:v1\0${secretKey}`).digest("hex");
}

/**
 * The id of the account a key belongs to (GET /v1/account), for the record;
 * null when Stripe does not let the key read it (restricted keys cannot).
 * Throws StripeUnavailableError when Stripe could not be asked.
 */
export async function readAccountId(secretKey: string): Promise<string | null> {
  let reply: StripeReply;
  try {
    reply = await stripeRequest(secretKey, "GET", "/v1/account");
  } catch {
    throw new StripeUnavailableError();
  }
  if (!reply.ok) {
    if (reply.status >= 500 || reply.status === 429) throw new StripeUnavailableError();
    return null;
  }
  return stripeId(reply.data.id, ID_PATTERNS.account);
}

export type DepositAddress = { id: string; address: string; livemode: boolean };

/** Thrown when Stripe answered, but not with what was asked. `notEnabled`: the crypto payment method is not enabled. */
export class StripeCryptoError extends Error {
  constructor(message: string, readonly notEnabled: boolean, readonly code: string | null) {
    super(message);
    this.name = "StripeCryptoError";
  }
}

/** A new Base deposit address of the operator's account. */
export async function createDepositAddress(secretKey: string): Promise<DepositAddress> {
  let reply: StripeReply;
  try {
    reply = await stripeRequest(secretKey, "POST", "/v1/crypto/deposit_addresses", {
      params: new URLSearchParams({ network: "base" }),
      stripeVersion: STRIPE_CRYPTO_API_VERSION,
    });
  } catch {
    throw new StripeUnavailableError();
  }
  if (!reply.ok) {
    if (reply.status >= 500 || reply.status === 429) throw new StripeUnavailableError();
    const notEnabled = isCryptoNotEnabled(reply);
    throw new StripeCryptoError(notEnabled ? "Stablecoins and Crypto is not enabled on the Stripe account" : "Stripe refused to create a deposit address", notEnabled, reply.error.code);
  }
  const id = stripeId(reply.data.id, ID_PATTERNS.cryptoDepositAddress);
  const address = typeof reply.data.address === "string" && EVM_ADDRESS.test(reply.data.address) ? reply.data.address.toLowerCase() : null;
  if (!id || !address || reply.data.network !== "base") throw new StripeCryptoError("Stripe answered with something that is not a Base deposit address", false, null);
  return { id, address, livemode: reply.data.livemode === true };
}

/** What became of the PaymentIntent of a settled payment. */
export type RecordOutcome =
  | { status: "succeeded"; paymentIntentId: string }
  /** Created, not succeeded yet (Stripe still checking): look again later. */
  | { status: "processing"; paymentIntentId: string }
  /** Stripe refused it: verification failed, or the payment method is not enabled. */
  | { status: "refused"; paymentIntentId: string | null; code: string | null; notEnabled: boolean };

function readIntent(data: Record<string, unknown>): RecordOutcome {
  const paymentIntentId = stripeId(data.id, ID_PATTERNS.paymentIntent);
  if (!paymentIntentId) throw new StripeUnavailableError();
  if (data.status === "succeeded") return { status: "succeeded", paymentIntentId };
  if (data.status === "requires_payment_method" || data.status === "canceled") return { status: "refused", paymentIntentId, code: String(data.status), notEnabled: false };
  return { status: "processing", paymentIntentId };
}

/**
 * The idempotency key of a recording attempt: the transaction hash, as
 * Stripe's guide uses it, for the first; after a refusal, the hash and the
 * attempt's number, so the next attempt is a new request rather than the
 * refusal replayed (Stripe keeps a key's answer for 24 hours). One
 * transaction still backs one payment: the database's unique indexes on the
 * transaction and the PaymentIntent see to that.
 */
export function recordIdempotencyKey(transaction: string, refusals: number): string {
  return refusals > 0 ? `${transaction}:${refusals + 1}` : transaction;
}

/**
 * Records a settled payment as a PaymentIntent (idempotency key:
 * recordIdempotencyKey, so a retry of the same attempt never records it
 * twice). Throws StripeUnavailableError when the outcome is unknown.
 */
export async function recordPayment(
  secretKey: string,
  input: { amountCents: number; transaction: string; paymentId: number; installId: string; refusals: number }
): Promise<RecordOutcome> {
  if (!TX_HASH.test(input.transaction) || !Number.isSafeInteger(input.amountCents) || input.amountCents < 1) {
    return { status: "refused", paymentIntentId: null, code: "invalid_record", notEnabled: false };
  }
  const params = new URLSearchParams();
  params.set("amount", String(input.amountCents));
  params.set("currency", "usd");
  params.set("confirm", "true");
  params.set("payment_method_data[type]", "crypto");
  params.append("allowed_payment_method_types[]", "crypto");
  params.set("payment_method_options[crypto][mode]", "transaction_verification");
  params.set("payment_method_options[crypto][transaction_verification_options][network]", "base");
  params.set("payment_method_options[crypto][transaction_verification_options][transaction_hash]", input.transaction);
  params.set("description", "API request paid with x402");
  params.set("metadata[ingressi_install]", input.installId);
  params.set("metadata[ingressi_kind]", "x402");
  params.set("metadata[ingressi_x402_payment_id]", String(input.paymentId));
  let reply: StripeReply;
  try {
    reply = await stripeRequest(secretKey, "POST", "/v1/payment_intents", {
      params,
      idempotencyKey: recordIdempotencyKey(input.transaction, input.refusals),
      stripeVersion: STRIPE_CRYPTO_API_VERSION,
    });
  } catch {
    throw new StripeUnavailableError();
  }
  if (reply.ok) return readIntent(reply.data);
  // An outage, a rate limit, or the same key still being processed: unknown.
  if (reply.status >= 500 || reply.status === 429 || reply.status === 409) throw new StripeUnavailableError();
  const intent = reply.error.paymentIntent;
  return {
    status: "refused",
    paymentIntentId: intent ? stripeId(intent.id, ID_PATTERNS.paymentIntent) : null,
    code: reply.error.code,
    notEnabled: isCryptoNotEnabled(reply),
  };
}

/** The PaymentIntent of an earlier attempt, looked at again. */
export async function readPaymentIntent(secretKey: string, paymentIntentId: string): Promise<RecordOutcome> {
  let reply: StripeReply;
  try {
    reply = await stripeRequest(secretKey, "GET", `/v1/payment_intents/${paymentIntentId}`, { stripeVersion: STRIPE_CRYPTO_API_VERSION });
  } catch {
    throw new StripeUnavailableError();
  }
  if (!reply.ok) throw new StripeUnavailableError();
  return readIntent(reply.data);
}
