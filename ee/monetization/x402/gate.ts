// SPDX-License-Identifier: Elastic-2.0
/**
 * x402 at the gate, on Stripe's machine payments
 * (docs.stripe.com/payments/machine/x402) and the official x402 SDK
 * (@x402/core, @x402/evm, @coinbase/x402). A monetized host with x402 on
 * answers a request without an API key (or one whose plan accepts x402 and
 * whose balance does not cover it) with 402: the gate's JSON body and
 * PAYMENT-REQUIRED, built by the SDK's resource server for USDC on Base,
 * paid to the operator's Stripe deposit address. A retry with
 * PAYMENT-SIGNATURE is handled here, the request forwarded only once the
 * payment is settled on chain AND Stripe confirmed the PaymentIntent that
 * records it.
 *
 * Order, money first:
 *  0. every attempt counts against the client's address (the address Caddy
 *     set on the subrequest, an IPv6 /48 as one); an address whose
 *     payments the facilitator keeps refusing is refused for the rest of the
 *     minute; the facilitator checks of a process are capped per second,
 *     each address getting a small share;
 *  1. the payload is decoded (x402 version 2). One whose nonce is already
 *     claimed is answered from its row at the amount it was paid at
 *     (answerKnown), even after a price change or with x402 off
 *     (redeemX402Payment); a new one must match this request's requirements
 *     exactly (the SDK's findMatchingRequirements: scheme, network, token,
 *     amount, receiving address), for this resource;
 *  2. the authorization nonce is claimed in the database (unique on network,
 *     token, payer and nonce): a payload is accepted once on every web node;
 *     one the facilitator refuses, or could not verify, leaves no row;
 *  3. the CDP facilitator verifies; only then does the payment count against
 *     its payer's per-minute limit (an unverified payer address could be
 *     anyone's);
 *  4. the facilitator settles (before forwarding: the only mode). The
 *     settlement must be for the verified payer and network; a settlement
 *     whose outcome is not known (no answer, or a transaction still pending)
 *     is kept as "unknown" for the operator, never settled again or
 *     forwarded. One transaction backs one payment (a unique index);
 *  5. the transaction is recorded with Stripe as a PaymentIntent, with the
 *     live key the deposit address was created with. Forwarded only when it
 *     succeeded. Stripe unreachable or still checking: 503, the payment kept
 *     as "recording", recorded by the reconciliation (reconcileX402Payments)
 *     or the client's retry of the same payload with the same idempotency
 *     key, and answered then. Stripe refusing it: asked again twice, a
 *     minute and ten minutes later, with new idempotency keys (Stripe
 *     documents no "not found yet" answer), then kept for the operator (the
 *     attention list shows it), never forwarded.
 *
 * Fail closed: the facilitator or Stripe unreachable never lets a request
 * through. Only the payer's address, the transaction hash and the
 * PaymentIntent id are stored or logged; the signature never is.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, lt } from "drizzle-orm";
import "./cdp-env";
import { createFacilitatorConfig } from "@coinbase/x402";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { appDb, nowIso } from "@/src/lib/db";
import { monetizationX402Payments } from "@/src/lib/db/schema";
import { first, isUniqueViolation } from "@/src/lib/db/ops";
import { createRateLimiter, type RateLimiter } from "@/src/lib/rate-limit";
import type { GateDenial } from "../engine";
import { gateContext, x402Context } from "../engine";
import { readGateSecret, readStripeSecrets } from "../settings";
import { isX402Configured, noteCryptoNotEnabled, readCdpKeySecret, readX402Config, type X402Config } from "./settings";
import { readPaymentIntent, recordPayment, StripeUnavailableError, type RecordOutcome } from "./stripe-crypto";

export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";
/** x402 version 1's payment header: such clients are asked for version 2. */
export const LEGACY_PAYMENT_HEADER = "X-PAYMENT";
const MAX_PAYMENT_HEADER_BYTES = 8 * 1024;
const NO_STORE = "no-store";
const EXPOSE = `${PAYMENT_REQUIRED_HEADER}, ${PAYMENT_RESPONSE_HEADER}`;
/** How long a payment may take, as the requirements tell the client. */
const MAX_TIMEOUT_SECONDS = 120;
/** Each facilitator call (verify, settle, supported). */
export const FACILITATOR_TIMEOUT_MS = 15_000;
/** After the facilitator's capabilities could not be fetched, they are not asked again for this long. */
const INIT_RETRY_MS = 30_000;
export const X402_PAYER_PER_MINUTE = 60;
/** A row still "verifying" or "settling" after this long was cut short (a crash): see reconcileX402Payments. */
export const X402_STALE_MS = 2 * 60_000;
/** A "recording" row is recorded again by the reconciliation once it is this old. */
const RECORD_RETRY_MS = 30_000;

export type X402Request = {
  hostId: number;
  /** The client's address bucket (the address Caddy set, GATE_CLIENT_IP_HEADER; an IPv6 /48), for the per-address limit. */
  clientAddress: string;
  /** The request's URL (scheme, host and path from Caddy's forwarded headers). */
  resourceUrl: string;
  header: (name: string) => string | null;
  now: number;
};

/** What a payment pays for: this request's requirements (one, USDC on Base), and who pays (a key holder, or nobody known). */
export type Offer = { requirements: PaymentRequirements[]; priceCents: number; consumerId: number | null; planId: number | null };

function json(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": NO_STORE, ...headers },
  });
}

// ── The SDK's resource server ────────────────────────────────────────

type ServerState = { key: string; server: x402ResourceServer; ready: Promise<void> | null; failedAt: number; requirements: Map<string, PaymentRequirements[]> };
const serverStore = globalThis as typeof globalThis & {
  __ingressiX402Server?: ServerState | null;
  /** The CDP secret read for one loaded x402 config: read again when the engine loads a new one (the settings changed). */
  __ingressiX402Secret?: { config: X402Config; secret: string | null } | null;
};

/** Tests only: build the resource server again on next use. */
export function resetX402ServerForTests(): void {
  serverStore.__ingressiX402Server = null;
  serverStore.__ingressiX402Secret = null;
}

/** The CDP API key secret for this config, read from the database once per loaded config (not per request). */
async function cdpSecretFor(config: X402Config): Promise<string | null> {
  const cached = serverStore.__ingressiX402Secret;
  if (cached && cached.config === config) return cached.secret;
  const secret = await readCdpKeySecret();
  serverStore.__ingressiX402Secret = { config, secret };
  return secret;
}

/**
 * The resource server for these credentials, its facilitator capabilities
 * fetched (initialize), or null when the facilitator cannot be reached (not
 * asked again for INIT_RETRY_MS).
 */
async function resourceServer(config: X402Config, now: number): Promise<ServerState | null> {
  const secret = await cdpSecretFor(config);
  if (!config.cdpKeyId || !secret) return null;
  const key = createHash("sha256").update(`${config.cdpKeyId}\0${secret}\0${config.network}`).digest("hex");
  let state = serverStore.__ingressiX402Server;
  if (!state || state.key !== key) {
    const facilitator = new HTTPFacilitatorClient({ ...createFacilitatorConfig(config.cdpKeyId, secret), timeoutMs: FACILITATOR_TIMEOUT_MS });
    state = { key, server: new x402ResourceServer(facilitator).register(config.network, new ExactEvmScheme()), ready: null, failedAt: 0, requirements: new Map() };
    serverStore.__ingressiX402Server = state;
  }
  if (!state.ready) {
    if (state.failedAt && now - state.failedAt < INIT_RETRY_MS) return null;
    const current = state;
    current.ready = current.server.initialize().catch((error: unknown) => {
      current.ready = null;
      current.failedAt = now;
      throw error;
    });
  }
  try {
    await state.ready;
    return state;
  } catch {
    console.warn("[x402] The CDP facilitator's capabilities could not be fetched; x402 is not offered for 30 seconds");
    return null;
  }
}

function priceString(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** This request's requirements: USDC on Base, `priceCents`, to the deposit address (the SDK builds them; cached). */
async function requirementsFor(state: ServerState, config: X402Config, priceCents: number): Promise<PaymentRequirements[]> {
  const key = `${priceCents}|${config.depositAddress}`;
  let requirements = state.requirements.get(key);
  if (!requirements) {
    requirements = await state.server.buildPaymentRequirements({
      scheme: "exact",
      network: config.network,
      payTo: config.depositAddress!,
      price: priceString(priceCents),
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    });
    if (state.requirements.size > 1_000) state.requirements.clear();
    state.requirements.set(key, requirements);
  }
  return requirements;
}

// ── The offer ────────────────────────────────────────────────────────

/**
 * This request's x402 offer; null when x402 does not apply (off or not set
 * up, a replica, a denial x402 does not answer: only a missing key, or a 402
 * of a plan that accepts x402); "unavailable" when it applies but the
 * facilitator cannot be reached or does not support USDC on Base (then
 * nothing is offered, and nothing let through).
 */
export async function x402OfferFor(request: Pick<X402Request, "hostId" | "now">, decision: GateDenial): Promise<Offer | "unavailable" | null> {
  const context = x402Context(request.hostId);
  if (!context || !isX402Configured(context.config)) return null;
  let consumerId: number | null = null;
  let planId: number | null = null;
  if (decision.status === 402 && decision.acceptX402 && decision.planId !== undefined) {
    consumerId = decision.consumerId ?? null;
    planId = decision.planId;
  } else if (!(decision.status === 401 && decision.error === "missing_api_key")) {
    return null;
  }
  const state = await resourceServer(context.config, request.now);
  if (!state) return "unavailable";
  const priceCents = context.host.priceCents ?? context.config.priceCents;
  try {
    return { requirements: await requirementsFor(state, context.config, priceCents), priceCents, consumerId, planId };
  } catch {
    // The facilitator does not offer exact payments on Base: nothing is offered, nothing let through.
    console.warn("[x402] The CDP facilitator does not support exact USDC payments on Base; x402 is not offered");
    return "unavailable";
  }
}

/** The request's URL as the client sent it, from the headers Caddy sets on the gate subrequest. */
export function resourceUrlOf(header: (name: string) => string | null): string {
  const proto = header("x-forwarded-proto") === "http" ? "http" : "https";
  const host = (header("x-forwarded-host") ?? "").split(",")[0].trim().toLowerCase();
  const uri = header("x-forwarded-uri") ?? "/";
  const safeHost = /^[a-z0-9.-]+(?::\d{1,5})?$/.test(host) ? host : "invalid.example";
  const safeUri = uri.startsWith("/") && uri.length <= 4096 && !/[\s\p{Cc}]/u.test(uri) ? uri : "/";
  return `${proto}://${safeHost}${safeUri}`;
}

/** The 402: the gate's JSON body, PAYMENT-REQUIRED (the SDK's), and why a payment was refused when it was. */
export async function x402RequiredResponse(
  decision: GateDenial,
  offer: Offer,
  resourceUrl: string,
  error: string | null,
  body: Record<string, unknown>,
  extra: Record<string, string> = {}
): Promise<Response> {
  const state = serverStore.__ingressiX402Server;
  const required = state
    ? await state.server.createPaymentRequiredResponse(offer.requirements, { url: resourceUrl }, error ?? undefined)
    : { x402Version: 2, resource: { url: resourceUrl }, accepts: offer.requirements, ...(error ? { error } : {}) };
  const { topUpUrl } = gateContext();
  const headers: Record<string, string> = {
    [PAYMENT_REQUIRED_HEADER]: encodePaymentRequiredHeader(required),
    Link: `<${topUpUrl}>; rel="payment"`,
    "Access-Control-Expose-Headers": EXPOSE,
    ...extra,
  };
  if (decision.status === 401 && decision.bearer) headers["WWW-Authenticate"] = 'Bearer realm="api"';
  const accepts = offer.requirements.map((requirement) => ({ network: requirement.network, networkLabel: "Base", token: "USDC", amount: requirement.amount, price: priceString(offer.priceCents) }));
  return json(402, { ...body, x402: { x402Version: 2, accepts, ...(error ? { error } : {}) } }, headers);
}

// ── Limits ───────────────────────────────────────────────────────────

const payerLimiter: RateLimiter = createRateLimiter({ name: "x402-payer", maxAttempts: X402_PAYER_PER_MINUTE + 1, windowMs: 60_000, blockMs: "window" });

/** Payment attempts per client address (an /48 for IPv6) and minute, whatever they carry. */
export const X402_ATTEMPTS_PER_ADDRESS_PER_MINUTE = 120;
const addressLimiter = createRateLimiter({ name: "x402-address", maxAttempts: X402_ATTEMPTS_PER_ADDRESS_PER_MINUTE + 1, windowMs: 60_000, blockMs: "window" });

/**
 * Payments the facilitator refused per address and minute: past them the
 * address is refused (429) before it costs another facilitator call. Kept in
 * memory per process (a refused payment is not worth a database write).
 */
export const X402_REFUSED_PAYMENTS_PER_MINUTE = 10;
const refusedLimiter = createRateLimiter({ name: "x402-refused-payments", maxAttempts: X402_REFUSED_PAYMENTS_PER_MINUTE, windowMs: 60_000, blockMs: "window", store: "memory" });

/**
 * Facilitator verifications per second and process, and per address: a few
 * addresses flooding cannot use up the facilitator's allowance for everyone.
 */
export const X402_VERIFICATIONS_PER_SECOND = 200;
export const X402_VERIFICATION_SHARE_PER_ADDRESS = 20;
const budget = { second: 0, used: 0, byAddress: new Map<string, number>() };

function takeVerification(address: string, now: number): boolean {
  const second = Math.floor(now / 1000);
  if (budget.second !== second) {
    budget.second = second;
    budget.used = 0;
    budget.byAddress.clear();
  }
  const mine = budget.byAddress.get(address) ?? 0;
  if (budget.used >= X402_VERIFICATIONS_PER_SECOND || mine >= X402_VERIFICATION_SHARE_PER_ADDRESS) return false;
  budget.used += 1;
  budget.byAddress.set(address, mine + 1);
  return true;
}

/** Tests only: the budget and every x402 limiter of this process start over. */
export async function resetX402LimitsForTests(): Promise<void> {
  budget.second = 0;
  budget.used = 0;
  budget.byAddress.clear();
  await refusedLimiter.clear();
  await addressLimiter.clear();
  await payerLimiter.clear();
}

// ── Paying ───────────────────────────────────────────────────────────

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NONCE = /^0x[0-9a-fA-F]{64}$/;

type Row = typeof monetizationX402Payments.$inferSelect;
type Authorization = { payer: string; nonce: string };
type Accepted = { network: string; asset: string; amountMicros: number };
type Decoded = { payload: PaymentPayload; authorization: Authorization | null; accepted: Accepted | null };

/** The payer and nonce of an exact EVM payment (EIP-3009 authorization), or null. */
function authorizationOf(payload: PaymentPayload): Authorization | null {
  const inner: unknown = payload.payload;
  if (typeof inner !== "object" || inner === null) return null;
  const authorization = (inner as { authorization?: unknown }).authorization;
  if (typeof authorization !== "object" || authorization === null) return null;
  const { from, nonce } = authorization as { from?: unknown; nonce?: unknown };
  return typeof from === "string" && ADDRESS.test(from) && typeof nonce === "string" && NONCE.test(nonce) ? { payer: from.toLowerCase(), nonce: nonce.toLowerCase() } : null;
}

/** What the payload says it pays (its `accepted` requirements): network, token and amount, or null. */
function acceptedOf(payload: PaymentPayload): Accepted | null {
  const accepted: unknown = payload.accepted;
  if (typeof accepted !== "object" || accepted === null) return null;
  const { network, asset, amount } = accepted as { network?: unknown; asset?: unknown; amount?: unknown };
  if (typeof network !== "string" || typeof asset !== "string" || typeof amount !== "string" || !/^\d{1,15}$/.test(amount)) return null;
  return { network, asset, amountMicros: Number(amount) };
}

/** Unique per network, token, payer and nonce: the token takes one authorization per nonce. */
function nonceKey(network: string, asset: string, payer: string, nonce: string): string {
  return createHash("sha256").update(`${network}|${asset.toLowerCase()}|${payer}|${nonce}`).digest("hex");
}

/** The PAYMENT-SIGNATURE header decoded, or why it cannot be. */
function decodePayment(header: string): Decoded | "invalid_payload" | "invalid_x402_version" {
  let payload: PaymentPayload;
  try {
    if (header.length > MAX_PAYMENT_HEADER_BYTES) throw new Error("too large");
    // The SDK decodes the JSON without checking its shape.
    const decoded: unknown = decodePaymentSignatureHeader(header);
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) throw new Error("not an object");
    payload = decoded as PaymentPayload;
  } catch {
    return "invalid_payload";
  }
  if (payload.x402Version !== 2) return "invalid_x402_version";
  return { payload, authorization: authorizationOf(payload), accepted: acceptedOf(payload) };
}

function unavailable(retryAfter: string, message: string): Response {
  return json(503, { error: "x402_unavailable", message }, { "Retry-After": retryAfter });
}

const UNAVAILABLE_MESSAGE = "Payments cannot be checked right now; try again shortly";
const RECORDING_MESSAGE =
  "The payment was settled and is being recorded; the request was not forwarded yet. Send the same payment again shortly: it is not taken twice";
const UNRECORDED_MESSAGE =
  "This payment could not be confirmed and recorded, and was not accepted for this request. Contact the API's operator with your wallet's transaction; the payment is kept for them to check";

type Identity = (consumerId: number, planId: number) => Record<string, string>;

/** The gate's identity headers for a key holder's payment, when this request is that key holder's. */
function identityFor(consumerId: number | null, decision: GateDenial, identity: Identity): Record<string, string> {
  if (consumerId === null || decision.status !== 402 || decision.consumerId !== consumerId || decision.planId === undefined) return {};
  return identity(consumerId, decision.planId);
}

function forward(settlement: SettleResponse, headers: Record<string, string>): Response {
  return new Response(null, {
    status: 200,
    headers: { ...headers, [PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(settlement), "Cache-Control": NO_STORE },
  });
}

function notRecorded(): Response {
  return json(409, { error: "payment_not_recorded", message: UNRECORDED_MESSAGE }, { "Access-Control-Expose-Headers": EXPOSE });
}

async function setStatus(id: number, values: Partial<typeof monetizationX402Payments.$inferInsert>, from: readonly string[]): Promise<boolean> {
  const updated = await appDb
    .update(monetizationX402Payments)
    .set({ ...values, updatedAt: nowIso() })
    .where(and(eq(monetizationX402Payments.id, id), inArray(monetizationX402Payments.status, [...from])))
    .returning({ id: monetizationX402Payments.id });
  return updated.length > 0;
}

/** setStatus, or "duplicate" when the transaction or PaymentIntent already backs another payment (unique indexes). */
async function setStatusUnlessDuplicate(id: number, values: Partial<typeof monetizationX402Payments.$inferInsert>, from: readonly string[]): Promise<boolean | "duplicate"> {
  try {
    return await setStatus(id, values, from);
  } catch (error) {
    if (isUniqueViolation(error)) return "duplicate";
    throw error;
  }
}

/** Recording attempts in all (the first and two more after Stripe refused), and how long each later one waits after a refusal. */
export const X402_RECORD_ATTEMPTS = 3;
const RECORD_RETRY_DELAYS_MS = [60_000, 10 * 60_000] as const;

/**
 * confirmed: Stripe confirmed the PaymentIntent. unrecorded: Stripe refused
 * it for the last time, or it would back a second payment. pending: Stripe is
 * still checking, or a refused attempt is retried later. stopped: Stripe
 * could not be reached, has not enabled crypto, or no live key set up for
 * x402 is set: nothing more is asked of Stripe for now.
 */
type RecordResult = "confirmed" | "unrecorded" | "pending" | "stopped";

/** Records a settled payment ("recording") with Stripe, or looks at its PaymentIntent again. */
async function recordWithStripe(row: Row, now: number): Promise<RecordResult> {
  if (row.status !== "recording" || !row.transaction) return "pending";
  if (row.recordAttempts > 0) {
    const wait = RECORD_RETRY_DELAYS_MS[Math.min(row.recordAttempts, RECORD_RETRY_DELAYS_MS.length) - 1];
    if (now - Date.parse(row.updatedAt) < wait) return "pending";
  }
  const [config, { secretKey }, gate] = await Promise.all([readX402Config(), readStripeSecrets(), readGateSecret()]);
  if (!secretKey || !gate?.installId || !config.stripeReady) {
    // The Stripe key was replaced or removed (or is a test key): its account may not own the deposit address. Kept until a live key set up for x402 can record it.
    if (row.errorReason !== "stripe_key_changed") await setStatus(row.id, { errorReason: "stripe_key_changed" }, ["recording"]);
    return "stopped";
  }
  let outcome: RecordOutcome;
  try {
    outcome = row.paymentIntentId
      ? await readPaymentIntent(secretKey, row.paymentIntentId)
      : await recordPayment(secretKey, { amountCents: centsOf(row.amountMicros), transaction: row.transaction, paymentId: row.id, installId: gate.installId, refusals: row.recordAttempts });
  } catch (error) {
    if (error instanceof StripeUnavailableError) return "stopped";
    throw error;
  }
  if (outcome.status === "succeeded") {
    const confirmed = await setStatusUnlessDuplicate(row.id, { status: "confirmed", paymentIntentId: outcome.paymentIntentId, errorReason: null }, ["recording"]);
    if (confirmed === "duplicate") {
      await setStatus(row.id, { status: "unrecorded", errorReason: "duplicate_payment_intent" }, ["recording"]);
      return "unrecorded";
    }
    await noteCryptoNotEnabled(false);
    return "confirmed";
  }
  if (outcome.status === "processing") {
    if ((await setStatusUnlessDuplicate(row.id, { paymentIntentId: outcome.paymentIntentId }, ["recording"])) === "duplicate") {
      await setStatus(row.id, { status: "unrecorded", errorReason: "duplicate_payment_intent" }, ["recording"]);
      return "unrecorded";
    }
    return "pending";
  }
  if (outcome.notEnabled) {
    // Settled on chain, the deposit address is Stripe's: recorded once the operator's account allows it.
    await setStatus(row.id, { errorReason: "stripe_not_enabled" }, ["recording"]);
    await noteCryptoNotEnabled(true);
    return "stopped";
  }
  const refusals = row.recordAttempts + 1;
  const reason = outcome.code ?? "stripe_refused";
  if (refusals < X402_RECORD_ATTEMPTS) {
    // Stripe documents no "not found yet" answer: any refusal is asked again later, with a new idempotency key.
    await setStatus(row.id, { recordAttempts: refusals, paymentIntentId: null, errorReason: reason }, ["recording"]);
    return "pending";
  }
  const final = await setStatusUnlessDuplicate(row.id, { status: "unrecorded", recordAttempts: refusals, paymentIntentId: outcome.paymentIntentId, errorReason: reason }, ["recording"]);
  if (final === "duplicate") await setStatus(row.id, { status: "unrecorded", recordAttempts: refusals, errorReason: reason }, ["recording"]);
  return "unrecorded";
}

/** Answers a settled payment: forwarded once Stripe confirmed it (and only by the request that claims it), otherwise not. */
async function answerSettled(paymentId: number, settlement: SettleResponse, result: RecordResult, headers: Record<string, string>): Promise<Response> {
  if (result === "confirmed") {
    // Forwarded once: only the request that moves the row from confirmed to settled.
    if (await setStatus(paymentId, { status: "settled" }, ["confirmed"])) return forward(settlement, headers);
    return json(409, { error: "payment_already_used", message: "This payment was already used for a request" });
  }
  if (result === "unrecorded") return notRecorded();
  return unavailable("10", RECORDING_MESSAGE);
}

/**
 * A payload whose nonce is already claimed: answered from its row, at the
 * amount it was paid at (the price or x402 itself may have changed since).
 * Settled and recorded, not answered yet: forwarded once; settled, not
 * recorded yet: recorded (or looked at) again; still being checked: wait;
 * kept for the operator: says so. Null when it was used (or is another
 * host's or payer's): the caller answers that.
 */
async function answerKnown(existing: Row, request: X402Request, decision: GateDenial, decoded: Decoded, identity: Identity): Promise<Response | null> {
  const { authorization, accepted } = decoded;
  if (!authorization || !accepted) return null;
  const same =
    existing.proxyHostId === request.hostId && existing.payer === authorization.payer && existing.network === accepted.network && existing.amountMicros === accepted.amountMicros;
  if (!same) return null;
  if (existing.status === "verifying" || existing.status === "settling") return unavailable("5", "This payment is being checked; send it again shortly");
  if (existing.status === "unrecorded" || existing.status === "unknown") return notRecorded();
  if (!existing.transaction || (existing.status !== "confirmed" && existing.status !== "recording")) return null;
  const settlement: SettleResponse = { success: true, transaction: existing.transaction, network: existing.network as SettleResponse["network"], payer: authorization.payer };
  const result = existing.status === "confirmed" ? "confirmed" : await recordWithStripe(existing, Date.now());
  return await answerSettled(existing.id, settlement, result, identityFor(existing.consumerId, decision, identity));
}

async function findKnown(decoded: Decoded): Promise<Row | null> {
  if (!decoded.authorization || !decoded.accepted) return null;
  const key = nonceKey(decoded.accepted.network, decoded.accepted.asset, decoded.authorization.payer, decoded.authorization.nonce);
  return (await first(appDb.select().from(monetizationX402Payments).where(eq(monetizationX402Payments.nonceKey, key)).limit(1))) ?? null;
}

/** Every attempt counts against the client's address, whatever it carries; an address the facilitator keeps refusing waits. */
async function limitAddress(request: X402Request): Promise<Response | null> {
  if ((await addressLimiter.registerAttempt(`address:${request.clientAddress}`)).blocked) {
    return json(429, { error: "rate_limited", message: "Too many payment attempts from this address; try again in a minute" }, { "Retry-After": "60" });
  }
  if ((await refusedLimiter.isRateLimited(`address:${request.clientAddress}`)).blocked) {
    return json(429, { error: "rate_limited", message: "Too many refused payments from this address; try again in a minute" }, { "Retry-After": "60" });
  }
  return null;
}

/**
 * A payment sent while x402 is not offered for this request (turned off, the
 * host's x402 off, or the facilitator unreachable): a payment already settled
 * for this host is still answered at its stored amount (forwarded once
 * Stripe confirmed it); anything else gets null (the caller's denial).
 */
export async function redeemX402Payment(request: X402Request, decision: GateDenial, identity: Identity): Promise<Response | null> {
  const header = request.header(PAYMENT_SIGNATURE_HEADER);
  if (!header) return null;
  const limited = await limitAddress(request);
  if (limited) return limited;
  const decoded = decodePayment(header);
  if (typeof decoded === "string") return null;
  const existing = await findKnown(decoded);
  return existing ? await answerKnown(existing, request, decision, decoded, identity) : null;
}

/**
 * Handles a request that carries a payment (PAYMENT-SIGNATURE), or answers
 * the offer. `identity` builds the gate's identity headers for a key holder.
 */
export async function payWithX402(request: X402Request, decision: GateDenial, offer: Offer, body: Record<string, unknown>, identity: Identity): Promise<Response> {
  const header = request.header(PAYMENT_SIGNATURE_HEADER);
  if (!header) {
    if (request.header(LEGACY_PAYMENT_HEADER)) return await x402RequiredResponse(decision, offer, request.resourceUrl, "invalid_x402_version", body);
    return await x402RequiredResponse(decision, offer, request.resourceUrl, null, body);
  }
  const limited = await limitAddress(request);
  if (limited) return limited;
  const decoded = decodePayment(header);
  if (typeof decoded === "string") return await x402RequiredResponse(decision, offer, request.resourceUrl, decoded, body);

  // A payload seen before is answered from its row, whatever this request's requirements are now.
  const existing = await findKnown(decoded);
  if (existing) {
    return (await answerKnown(existing, request, decision, decoded, identity)) ?? (await x402RequiredResponse(decision, offer, request.resourceUrl, "payment_already_used", body));
  }

  const { payload, authorization } = decoded;
  const state = serverStore.__ingressiX402Server;
  // The SDK's match: scheme, network, token, amount and receiving address exactly as offered.
  const requirements = state?.server.findMatchingRequirements(offer.requirements, payload);
  if (!state || !requirements) return await x402RequiredResponse(decision, offer, request.resourceUrl, "invalid_payment_requirements", body);
  if (payload.resource?.url !== undefined && payload.resource.url !== request.resourceUrl) {
    return await x402RequiredResponse(decision, offer, request.resourceUrl, "invalid_resource", body);
  }
  if (!authorization) return await x402RequiredResponse(decision, offer, request.resourceUrl, "invalid_payload", body);
  const amountMicros = Number(requirements.amount);
  if (!takeVerification(request.clientAddress, request.now)) return unavailable("1", UNAVAILABLE_MESSAGE);

  // The nonce, claimed once for every web node.
  const key = nonceKey(requirements.network, requirements.asset, authorization.payer, authorization.nonce);
  const stamp = nowIso();
  let paymentId: number;
  try {
    const row = await first(appDb
      .insert(monetizationX402Payments)
      .values({
        proxyHostId: request.hostId,
        consumerId: offer.consumerId,
        payer: authorization.payer,
        network: requirements.network,
        asset: requirements.asset,
        amountMicros,
        nonceKey: key,
        status: "verifying",
        createdAt: stamp,
        updatedAt: stamp,
      })
      .returning({ id: monetizationX402Payments.id }));
    paymentId = row!.id;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Claimed by another request meanwhile.
    return unavailable("5", "This payment is being checked; send it again shortly");
  }
  const release = () => appDb.delete(monetizationX402Payments).where(and(eq(monetizationX402Payments.id, paymentId), eq(monetizationX402Payments.status, "verifying")));

  let verified: VerifyResponse;
  try {
    verified = await state.server.verifyPayment(payload, requirements);
  } catch (error) {
    await release();
    const reason = (error as { invalidReason?: unknown }).invalidReason;
    if (typeof reason !== "string") return unavailable("5", UNAVAILABLE_MESSAGE);
    verified = { isValid: false, invalidReason: reason };
  }
  // A verification that names another payer than the authorization's is not this payment's.
  if (verified.isValid && typeof verified.payer === "string" && verified.payer.toLowerCase() !== authorization.payer) {
    verified = { isValid: false, invalidReason: "payer_mismatch" };
  }
  if (!verified.isValid) {
    // Nothing moved and nothing is kept; the address's refusals are counted.
    await release();
    await refusedLimiter.registerAttempt(`address:${request.clientAddress}`);
    return await x402RequiredResponse(decision, offer, request.resourceUrl, safeReason(verified.invalidReason), body);
  }
  // Counted per payer only once the facilitator vouched for the payer: an unverified "from" cannot use up someone else's limit.
  if ((await payerLimiter.registerAttempt(`payer:${authorization.payer}`)).blocked) {
    await release();
    return json(429, { error: "rate_limited", message: "Too many paid requests from this payer; try again in a minute" }, { "Retry-After": "60" });
  }
  if (!(await setStatus(paymentId, { status: "settling" }, ["verifying"]))) return unavailable("5", UNAVAILABLE_MESSAGE);

  let settlement: SettleResponse;
  try {
    settlement = await state.server.settlePayment(payload, requirements);
  } catch (error) {
    const failed = error as { errorReason?: unknown; transaction?: unknown };
    if (typeof failed.errorReason === "string") {
      settlement = { success: false, errorReason: failed.errorReason, transaction: typeof failed.transaction === "string" ? failed.transaction : "", network: requirements.network };
    } else {
      // A timeout or an outage: whether the money moved is not known. Kept for the operator, not forwarded.
      await setStatus(paymentId, { status: "unknown", errorReason: "settle_unavailable" }, ["settling"]);
      return unavailable("5", "The payment could not be settled right now and the request was not forwarded. Its state is not known; contact the API's operator if your wallet shows the transfer");
    }
  }
  if (!settlement.success && settlement.transaction) {
    // A transaction was sent but not confirmed (settlement_pending after the SDK's one retry): it may still move the
    // money. Kept with its transaction for the operator, never forwarded.
    if ((await setStatusUnlessDuplicate(paymentId, { status: "unknown", transaction: settlement.transaction, errorReason: safeReason(settlement.errorReason) }, ["settling"])) === "duplicate") {
      await setStatus(paymentId, { status: "unknown", errorReason: "duplicate_transaction" }, ["settling"]);
    }
    return unavailable("5", "The payment's transaction was sent but is not confirmed, and the request was not forwarded. Contact the API's operator with your wallet's transaction");
  }
  if (!settlement.success || !settlement.transaction) {
    await setStatus(paymentId, { status: "failed", errorReason: safeReason(settlement.errorReason) }, ["settling"]);
    return await x402RequiredResponse(decision, offer, request.resourceUrl, safeReason(settlement.errorReason), body, {
      [PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader({ ...settlement, success: false }),
    });
  }
  // A settlement for another network or payer than the one verified is not this payment's: kept for the operator.
  const settledPayer = typeof settlement.payer === "string" ? settlement.payer.toLowerCase() : null;
  if (settlement.network !== requirements.network || (settledPayer !== null && settledPayer !== authorization.payer)) {
    if ((await setStatusUnlessDuplicate(paymentId, { status: "unknown", transaction: settlement.transaction, errorReason: "settlement_mismatch" }, ["settling"])) === "duplicate") {
      await setStatus(paymentId, { status: "unknown", errorReason: "settlement_mismatch" }, ["settling"]);
    }
    return notRecorded();
  }
  // Settled on chain: recorded with Stripe before anything is forwarded. One transaction backs one payment.
  if ((await setStatusUnlessDuplicate(paymentId, { status: "recording", transaction: settlement.transaction }, ["settling"])) === "duplicate") {
    await setStatus(paymentId, { status: "unrecorded", errorReason: "duplicate_transaction" }, ["settling"]);
    return notRecorded();
  }
  const row = await first(appDb.select().from(monetizationX402Payments).where(eq(monetizationX402Payments.id, paymentId)).limit(1));
  const result = row ? await recordWithStripe(row, Date.now()) : "pending";
  const headers = offer.consumerId !== null && offer.planId !== null ? identity(offer.consumerId, offer.planId) : {};
  return await answerSettled(paymentId, settlement, result, headers);
}

/** USDC micro-units (six decimals) as US cents: what the PaymentIntent records. */
function centsOf(amountMicros: number): number {
  return Math.round(amountMicros / 10_000);
}

function safeReason(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value) ? value : "invalid_payment";
}

/**
 * The leader's reconciliation (every minute): a nonce claimed but never
 * verified is released; a settlement whose outcome never came back is kept as
 * "unknown"; a settled payment Stripe has not confirmed yet is recorded (or
 * its PaymentIntent looked at) again: with the same idempotency key after an
 * unknown outcome, with the next one after a refusal (X402_RECORD_ATTEMPTS).
 */
export async function reconcileX402Payments(now: number = Date.now()): Promise<{ released: number; interrupted: number; recorded: number }> {
  const stale = new Date(now - X402_STALE_MS).toISOString();
  const released = await appDb
    .delete(monetizationX402Payments)
    .where(and(eq(monetizationX402Payments.status, "verifying"), lt(monetizationX402Payments.updatedAt, stale)))
    .returning({ id: monetizationX402Payments.id });
  const interrupted = await appDb
    .update(monetizationX402Payments)
    .set({ status: "unknown", errorReason: "settle_interrupted", updatedAt: nowIso() })
    .where(and(eq(monetizationX402Payments.status, "settling"), lt(monetizationX402Payments.updatedAt, stale)))
    .returning({ id: monetizationX402Payments.id });
  const rows = await appDb
    .select()
    .from(monetizationX402Payments)
    .where(and(eq(monetizationX402Payments.status, "recording"), lt(monetizationX402Payments.updatedAt, new Date(now - RECORD_RETRY_MS).toISOString())))
    .orderBy(monetizationX402Payments.id)
    .limit(100);
  let recorded = 0;
  for (const row of rows) {
    const result = await recordWithStripe(row, now);
    if (result === "confirmed") recorded += 1;
    // Stripe unreachable, crypto not enabled, or no live key set up for x402: the rest waits for the next run.
    if (result === "stopped") break;
  }
  return { released: released.length, interrupted: interrupted.length, recorded };
}
