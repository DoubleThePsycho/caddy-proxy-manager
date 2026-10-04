// SPDX-License-Identifier: Elastic-2.0
/**
 * The few Stripe API calls API monetization makes, with the operator's own
 * secret key (form-encoded, as Stripe's API takes them). No SDK: the calls
 * are plain HTTPS requests with a timeout, an idempotency key for every
 * write, and replies read as untrusted JSON.
 *
 * Errors: a request that never got an answer (network, timeout) throws
 * PaymentProviderError; an answer from Stripe, success or refusal, is
 * returned with its HTTP status, so callers can tell a declined card (402)
 * from an outage (5xx, retried with the same idempotency key). Nothing here
 * logs a key, a request body or a reply.
 */
export const STRIPE_API_BASE = "https://api.stripe.com";
const TIMEOUT_MS = 15_000;

/** A Stripe request failed; the message is safe to show (no response body or key). */
export class PaymentProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentProviderError";
  }
}

export type StripeErrorBody = {
  type: string | null;
  code: string | null;
  declineCode: string | null;
  /** Stripe's own message (shown to administrators only, never to API consumers). */
  message: string | null;
  /** The PaymentIntent of a failed confirmation (card errors carry it). */
  paymentIntent: Record<string, unknown> | null;
};

export type StripeReply =
  | { ok: true; status: number; data: Record<string, unknown> }
  | { ok: false; status: number; error: StripeErrorBody };

const SAFE_CODE = /^[a-z0-9_]{1,64}$/;

function safeCode(value: unknown): string | null {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One Stripe API call. `params` are form fields; writes carry `idempotencyKey`. */
export async function stripeRequest(
  secretKey: string,
  method: "GET" | "POST",
  path: string,
  options: { params?: URLSearchParams; idempotencyKey?: string; stripeVersion?: string } = {}
): Promise<StripeReply> {
  const query = method === "GET" && options.params ? `?${options.params.toString()}` : "";
  let response: Response;
  try {
    response = await fetch(`${STRIPE_API_BASE}${path}${query}`, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
        ...(options.stripeVersion ? { "Stripe-Version": options.stripeVersion } : {}),
      },
      body: method === "POST" ? (options.params ?? new URLSearchParams()).toString() : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new PaymentProviderError("Stripe could not be reached");
  }
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    // An answer that is not JSON: an outage in front of Stripe.
  }
  if (response.ok && isRecord(data)) return { ok: true, status: response.status, data };
  const error = isRecord(data) && isRecord(data.error) ? data.error : {};
  return {
    ok: false,
    status: response.ok ? 502 : response.status,
    error: {
      type: safeCode(error.type),
      code: safeCode(error.code),
      declineCode: safeCode(error.decline_code),
      message: typeof error.message === "string" ? error.message.slice(0, 500) : null,
      paymentIntent: isRecord(error.payment_intent) ? error.payment_intent : null,
    },
  };
}

/** " (code)" for a refusal's code, for messages and logs. */
export function errorSuffix(reply: Extract<StripeReply, { ok: false }>): string {
  return reply.error.code ? ` (${reply.error.code})` : "";
}

/** A string field of a Stripe object matching `pattern`, or null. */
export function stripeId(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && value.length <= 255 && pattern.test(value) ? value : null;
}

export const ID_PATTERNS = {
  customer: /^cus_[A-Za-z0-9]{1,250}$/,
  paymentMethod: /^(?:pm|card|src)_[A-Za-z0-9]{1,250}$/,
  paymentIntent: /^pi_[A-Za-z0-9]{1,250}$/,
  cryptoDepositAddress: /^cda_[A-Za-z0-9]{1,250}$/,
  account: /^acct_[A-Za-z0-9]{1,250}$/,
  setupIntent: /^seti_[A-Za-z0-9]{1,250}$/,
  checkoutSession: /^cs_[A-Za-z0-9_]{1,250}$/,
  charge: /^(?:ch|py)_[A-Za-z0-9]{1,250}$/,
  dispute: /^(?:dp|du)_[A-Za-z0-9]{1,250}$/,
} as const;

/** Brand, last four and expiry of a card PaymentMethod object (anything else: null). */
export function readCard(paymentMethod: unknown): { id: string; brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null } | null {
  if (!isRecord(paymentMethod)) return null;
  const id = stripeId(paymentMethod.id, ID_PATTERNS.paymentMethod);
  const card = isRecord(paymentMethod.card) ? paymentMethod.card : null;
  if (!id || !card) return null;
  const brand = typeof card.brand === "string" && /^[a-z_]{1,32}$/.test(card.brand) ? card.brand : null;
  const last4 = typeof card.last4 === "string" && /^\d{4}$/.test(card.last4) ? card.last4 : null;
  const expMonth = Number.isInteger(card.exp_month) && (card.exp_month as number) >= 1 && (card.exp_month as number) <= 12 ? (card.exp_month as number) : null;
  const expYear = Number.isInteger(card.exp_year) && (card.exp_year as number) >= 2000 && (card.exp_year as number) <= 2200 ? (card.exp_year as number) : null;
  return { id, brand, last4, expMonth, expYear };
}
