// SPDX-License-Identifier: Elastic-2.0
/**
 * The HTTP answer of the gate for one decision. Caddy copies a 2xx answer's
 * X-Ingressi-Consumer-Id and X-Ingressi-Plan to the request and continues to
 * the upstream; any other answer reaches the client as written here.
 */
import { ensureMonetizationLoaded, gateContext, precheckGate, type GateDecision, type GateDenial, type GateRequest } from "./engine";
import { monetizationBalanceStore } from "./balance-store";
import { microsToDecimal } from "./money";
import { CHARGE_HEADER, CONSUMER_ID_HEADER, GATE_CLIENT_IP_HEADER, GATE_HOST_ID_HEADER, GATE_TOKEN_HEADER, PLAN_HEADER } from "./types";
import { ipRateLimitBucket, parseClientIp } from "@/src/lib/client-ip";

const NO_STORE = "no-store";

function json(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": NO_STORE, ...headers },
  });
}

const FORBIDDEN_MESSAGES = {
  host_not_monetized: "API monetization is not enabled for this host",
  consumer_disabled: "This API consumer is disabled",
  plan_not_allowed: "Your plan does not include this API",
  no_plan: "This API consumer has no plan",
} as const;

const OVERDUE_MESSAGES = {
  payment_failed: "A charge of the saved card failed; pay the open amount to continue",
  authentication_required: "Your bank asked to confirm a charge; pay the open amount to continue",
  dispute: "A payment of this account is disputed; contact the API provider",
  billing_switch: "The billing of this account is being changed; try again in a few seconds",
} as const;

export function gateResponse(decision: GateDecision): Response {
  if (decision.allow) {
    return new Response(null, {
      status: 200,
      headers: {
        [CONSUMER_ID_HEADER]: String(decision.consumerId),
        [PLAN_HEADER]: String(decision.planId),
        // Caddy writes it into the request's access log line (failed-answer credits).
        ...(decision.chargeId ? { [CHARGE_HEADER]: decision.chargeId } : {}),
        "Cache-Control": NO_STORE,
      },
    });
  }
  switch (decision.status) {
    case 401: {
      const where = decision.bearer ? "Authorization: Bearer <key>" : `the ${decision.keyHeader} header`;
      return json(
        401,
        {
          error: decision.error,
          message: decision.error === "missing_api_key" ? `An API key is required in ${where}` : "The API key is not valid",
        },
        decision.bearer ? { "WWW-Authenticate": 'Bearer realm="api"' } : {}
      );
    }
    case 403:
      // A call without the gate token did not come from the generated Caddy configuration: say nothing more.
      if (decision.error === "forbidden") return json(403, { error: "forbidden" });
      return json(403, { error: decision.error, message: FORBIDDEN_MESSAGES[decision.error] });
    case 429:
      return json(
        429,
        {
          error: decision.error,
          message: `Rate limit of ${decision.limit} requests per minute exceeded`,
          limit: decision.limit,
          retryAfter: decision.retryAfterSeconds,
        },
        { "Retry-After": String(decision.retryAfterSeconds) }
      );
    case 402:
      return json(402, paymentRequiredBody(decision), {
        Link: `<${gateContext().topUpUrl}>; rel="payment"`,
        // A billing switch takes seconds: nothing to pay, just try again.
        ...(decision.error === "payment_overdue" && decision.reason === "billing_switch" ? { "Retry-After": "5" } : {}),
      });
    case 503:
      // The shared balances (high availability) cannot be reached: refused, never let through uncharged.
      return json(503, { error: decision.error, message: "The API is temporarily unavailable; try again shortly" }, { "Retry-After": "5" });
  }
}

type PaymentDenial = Extract<GateDecision, { status: 402 }>;

/** The JSON body of a 402: what is owed or missing, and where to pay. */
export function paymentRequiredBody(decision: PaymentDenial): Record<string, unknown> {
  const { currency, topUpUrl } = gateContext();
  const upper = currency.toUpperCase();
  switch (decision.error) {
    case "payment_required":
      return {
        error: decision.error,
        message: "The prepaid balance does not cover this request; top up to continue",
        balance: microsToDecimal(decision.balanceMicros, currency),
        price: microsToDecimal(decision.priceMicros, currency),
        balanceMicros: decision.balanceMicros,
        priceMicros: decision.priceMicros,
        currency: upper,
        topUpUrl,
      };
    case "usage_cap_reached":
      return {
        error: decision.error,
        message: `Unpaid usage has reached the limit of ${microsToDecimal(decision.capMicros, currency)} ${upper}; pay the open amount to continue`,
        openAmount: microsToDecimal(decision.openAmountMicros, currency),
        cap: microsToDecimal(decision.capMicros, currency),
        price: microsToDecimal(decision.priceMicros, currency),
        openAmountMicros: decision.openAmountMicros,
        capMicros: decision.capMicros,
        priceMicros: decision.priceMicros,
        currency: upper,
        paymentUrl: topUpUrl,
      };
    case "payment_method_required":
      return { error: decision.error, message: "Save a card in the portal to use this API", paymentUrl: topUpUrl };
    case "payment_overdue":
      return { error: decision.error, message: OVERDUE_MESSAGES[decision.reason], reason: decision.reason, paymentUrl: topUpUrl };
  }
}

/**
 * x402 on hosts that offer it (x402/gate.ts): a request without a key, or a
 * key holder whose plan accepts x402 and whose balance does not cover it,
 * gets a 402 with the x402 requirements, and a retry with a payment is
 * verified, settled and recorded with Stripe. Null when x402 does not apply
 * to this denial.
 */
async function x402Answer(headers: Headers, decision: GateDenial, now: number): Promise<Response | null> {
  if (decision.status !== 401 && decision.status !== 402) return null;
  const hostId = Number(headers.get(GATE_HOST_ID_HEADER));
  if (!Number.isSafeInteger(hostId) || hostId < 1) return null;
  const { payWithX402, redeemX402Payment, resourceUrlOf, x402OfferFor } = await import("./x402/gate");
  const header = (name: string) => headers.get(name);
  // The address Caddy set on the subrequest (never a header the client controls), an IPv6 /48 as one.
  const clientIp = parseClientIp(headers.get(GATE_CLIENT_IP_HEADER));
  const request = { hostId, clientAddress: clientIp ? ipRateLimitBucket(clientIp, 48) : "unknown", resourceUrl: resourceUrlOf(header), header, now };
  const identity = (consumerId: number, planId: number) => ({ [CONSUMER_ID_HEADER]: String(consumerId), [PLAN_HEADER]: String(planId) });
  const offer = await x402OfferFor(request, decision);
  if (offer === null || offer === "unavailable") {
    if (!headers.get("payment-signature")) return null;
    // Not offered now (x402 or the host's x402 turned off, or the facilitator unreachable): a payment settled
    // earlier for this host is still answered; nothing new is taken.
    const known = await redeemX402Payment(request, decision, identity);
    if (known) return known;
    if (offer === null) return null;
    return new Response(JSON.stringify({ error: "x402_unavailable", message: "Payments cannot be checked right now; try again shortly" }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": "30" },
    });
  }
  const body =
    decision.status === 402
      ? paymentRequiredBody(decision)
      : {
          error: "payment_required",
          message: `Send an API key in ${decision.bearer ? "Authorization: Bearer <key>" : `the ${decision.keyHeader} header`}, or pay for this request with x402 (see the PAYMENT-REQUIRED header)`,
          topUpUrl: gateContext().topUpUrl,
        };
  return await payWithX402(request, decision, offer, body, identity);
}

/**
 * The gate endpoint: no database access once the state is loaded. Counters
 * are this process's, or with high availability shared state one atomic
 * script on the shared server per request; a shared state that cannot be
 * reached refuses the request (503).
 */
export async function handleGateRequest(headers: Headers, now?: number): Promise<Response> {
  await ensureMonetizationLoaded();
  const request: GateRequest = {
    gateToken: headers.get(GATE_TOKEN_HEADER),
    hostId: headers.get(GATE_HOST_ID_HEADER),
    header: (name) => headers.get(name),
    now,
  };
  let decision: GateDecision;
  try {
    decision = await (await monetizationBalanceStore()).decide(request);
  } catch {
    // Callers without the gate token learn nothing about the shared state.
    const checked = precheckGate(request);
    decision = "allow" in checked ? checked : { allow: false, status: 503, error: "unavailable" };
  }
  if (!decision.allow) {
    const x402 = await x402Answer(headers, decision, now ?? Date.now());
    if (x402) return x402;
  }
  return gateResponse(decision);
}
