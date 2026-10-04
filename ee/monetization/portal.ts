// SPDX-License-Identifier: Elastic-2.0
/**
 * What a consumer sees about themselves: on the self-service portal page
 * (/api-portal/<token>, a per-consumer link the administrator issues), on the
 * key-based portal page (/api-portal, the consumer pastes an API key) and from
 * the consumer API (GET /api/monetization/me with the API key).
 *
 * None of these check the license or need a dashboard account. Portal tokens
 * are looked up by their SHA-256; API keys through the gate's in-memory index.
 *
 * Postpaid consumers see their open amount, the cap, when the next charge
 * runs and their card (brand and last four digits only), and can save a card
 * and pay the open amount in Stripe Checkout (postpaid.ts).
 */
import { eq } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { monetizationPlans } from "@/src/lib/db/schema";
import { ApiClientError } from "@/src/lib/api-errors";
import { config } from "@/src/lib/config";
import { authenticateConsumerKey, ensureMonetizationLoaded } from "./engine";
import { monetizationBalanceStore } from "./balance-store";
import { consumerByPortalTokenHash, effectiveCounters, getConsumerRow, portalUrl } from "./consumers";
import { isPortalTokenShape, sha256Hex } from "./keys";
import { recentLedger } from "./ledger";
import { createTopUpCheckout, getStripeSettingsView } from "./payments";
import { createCardSetupCheckout, createOpenAmountCheckout, effectiveBilling, postpaidViews } from "./postpaid";
import { PORTAL_PATH, type BillingMode, type ConsumerStatus, type PostpaidView } from "./types";
import { first } from "@/src/lib/db/ops";

export type ConsumerSummary = {
  consumer: { id: number; name: string; status: ConsumerStatus };
  plan: {
    id: number;
    name: string;
    pricePerRequestMicros: number;
    includedRequestsPerMonth: number;
    requestsPerMinute: number | null;
  } | null;
  currency: string;
  balanceMicros: number;
  overdraftAllowanceMicros: number;
  includedRequestsUsed: number;
  includedRequestsRemaining: number;
  topUpsAvailable: boolean;
  topUpAmountsMicros: number[];
  billing: BillingMode;
  /** Postpaid: the open amount, cap, next charge, card and state; null for prepaid consumers. */
  postpaid: (PostpaidView & { paymentsAvailable: boolean }) | null;
  recentActivity: Array<{
    type: string;
    amountMicros: number;
    balanceAfterMicros: number;
    requests: number;
    freeRequests: number;
    createdAt: string;
    updatedAt: string;
  }>;
};

type ConsumerRow = NonNullable<Awaited<ReturnType<typeof getConsumerRow>>>;

export async function consumerSummary(row: ConsumerRow): Promise<ConsumerSummary> {
  await ensureMonetizationLoaded();
  const plan = row.planId === null ? undefined : await first(appDb.select().from(monetizationPlans).where(eq(monetizationPlans.id, row.planId)).limit(1));
  const counters = (await effectiveCounters([row])).get(row.id) ?? { balanceMicros: row.balanceMicros, includedRequestsUsed: 0 };
  const payments = await getStripeSettingsView();
  const included = plan?.includedRequestsPerMonth ?? 0;
  const billing = effectiveBilling(row, plan ?? null);
  const postpaid = billing === "postpaid" ? (await postpaidViews([row], new Map([[row.id, counters]]))).get(row.id) ?? null : null;
  return {
    consumer: { id: row.id, name: row.name, status: row.status === "disabled" ? "disabled" : "active" },
    plan: plan
      ? {
          id: plan.id,
          name: plan.name,
          pricePerRequestMicros: plan.pricePerRequestMicros,
          includedRequestsPerMonth: plan.includedRequestsPerMonth,
          requestsPerMinute: plan.requestsPerMinute,
        }
      : null,
    currency: payments.currency,
    balanceMicros: counters.balanceMicros,
    overdraftAllowanceMicros: row.overdraftAllowanceMicros,
    includedRequestsUsed: counters.includedRequestsUsed,
    includedRequestsRemaining: Math.max(0, included - counters.includedRequestsUsed),
    topUpsAvailable: billing === "prepaid" && payments.configured && payments.topUpAmountsMicros.length > 0,
    topUpAmountsMicros: billing === "prepaid" && payments.configured ? payments.topUpAmountsMicros : [],
    billing,
    postpaid: postpaid ? { ...postpaid, paymentsAvailable: payments.configured } : null,
    recentActivity: (await recentLedger(row.id, 20)).map((entry) => ({
      type: entry.type,
      amountMicros: entry.amountMicros,
      balanceAfterMicros: entry.balanceAfterMicros,
      requests: entry.requests,
      freeRequests: entry.freeRequests,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    })),
  };
}

/** The consumer behind a portal token, or null for an unknown or malformed token. */
export async function consumerForPortalToken(token: unknown): Promise<ConsumerRow | null> {
  if (!isPortalTokenShape(token)) return null;
  return await consumerByPortalTokenHash(sha256Hex(token));
}

/** The key sent as "Authorization: Bearer <key>" or "X-API-Key: <key>". */
export function presentedApiKey(headers: Headers): string | null {
  const authorization = headers.get("authorization");
  const bearer = authorization ? /^Bearer[ \t]+([^\s]+)[ \t]*$/i.exec(authorization)?.[1] : undefined;
  const key = bearer ?? headers.get("x-api-key")?.trim();
  return key ? key : null;
}

/** The consumer of the presented API key; 401 otherwise, 429 when called too often. */
export async function consumerForApiKey(headers: Headers): Promise<ConsumerRow> {
  const raw = presentedApiKey(headers);
  const match = raw ? await authenticateConsumerKey(raw) : null;
  const row = match ? await getConsumerRow(match.consumerId) : null;
  if (!row) throw new ApiClientError("A valid API key is required (Authorization: Bearer <key> or X-API-Key)", 401);
  if (!(await (await monetizationBalanceStore()).allowCall(`me:${row.id}`, 60, 60_000))) {
    throw new ApiClientError("Too many requests; try again in a minute", 429);
  }
  return row;
}

/** Creates a Checkout Session for an active consumer, at most 10 per consumer every 10 minutes. */
export async function startTopUp(row: ConsumerRow, amountMicros: unknown, returnTo: string): Promise<{ url: string }> {
  if (row.status !== "active") throw new ApiClientError("This API consumer is disabled", 403);
  const plan = row.planId === null ? null : await first(appDb.select().from(monetizationPlans).where(eq(monetizationPlans.id, row.planId)).limit(1));
  if (effectiveBilling(row, plan) === "postpaid") {
    throw new ApiClientError("This account pays after use: save a card or pay the open amount instead of topping up", 409);
  }
  if (typeof amountMicros !== "number" || !Number.isSafeInteger(amountMicros)) {
    throw new ApiClientError("amountMicros must be one of the offered top-up amounts", 400);
  }
  if (!(await (await monetizationBalanceStore()).allowCall(`checkout:${row.id}`, 10, 600_000))) {
    throw new ApiClientError("Too many top-up attempts; try again in a few minutes", 429);
  }
  const url = await createTopUpCheckout({ id: row.id, name: row.name, email: row.email }, amountMicros, {
    successUrl: `${returnTo}?topup=success`,
    cancelUrl: `${returnTo}?topup=cancelled`,
  });
  return { url };
}

/** A setup-mode Checkout Session saving a card (postpaid), at most 10 per consumer every 10 minutes. */
export async function startCardSetup(row: ConsumerRow, returnTo: string): Promise<{ url: string }> {
  if (!(await (await monetizationBalanceStore()).allowCall(`card:${row.id}`, 10, 600_000))) {
    throw new ApiClientError("Too many attempts; try again in a few minutes", 429);
  }
  return { url: await createCardSetupCheckout(row.id, { successUrl: `${returnTo}?card=saved`, cancelUrl: `${returnTo}?card=cancelled` }) };
}

/** A Checkout Session paying the open amount (postpaid), at most 10 per consumer every 10 minutes. */
export async function startOpenAmountPayment(row: ConsumerRow, returnTo: string): Promise<{ url: string }> {
  if (!(await (await monetizationBalanceStore()).allowCall(`pay:${row.id}`, 10, 600_000))) {
    throw new ApiClientError("Too many attempts; try again in a few minutes", 429);
  }
  return { url: await createOpenAmountCheckout(row.id, { successUrl: `${returnTo}?payment=success`, cancelUrl: `${returnTo}?payment=cancelled` }) };
}

export function portalReturnUrl(token: string | null): string {
  return token ? portalUrl(token) : `${config.baseUrl}${PORTAL_PATH}`;
}
