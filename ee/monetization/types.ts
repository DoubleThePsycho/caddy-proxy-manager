// SPDX-License-Identifier: Elastic-2.0
/**
 * API monetization: shared constants and the JSON shapes of the REST API and
 * the dashboard. Client-safe (no database or Node imports).
 *
 * Money: every amount is an integer number of micro-units of the install's
 * currency (1 USD = 1,000,000 micro-units, 1 JPY = 1,000,000 micro-units), so
 * a price per request can be a fraction of a cent. Fields carry a "Micros"
 * suffix; see money.ts for conversions.
 */

/** Header Caddy sets on the gate subrequest with the per-install gate token. */
export const GATE_TOKEN_HEADER = "X-Ingressi-Gate-Token";
/** Header Caddy sets on the gate subrequest: the proxy host whose route issued it. */
export const GATE_HOST_ID_HEADER = "X-Ingressi-Host-Id";
/**
 * The client's address, set by Caddy on the gate subrequest from
 * {http.vars.client_ip} (the connection's address, or the one trusted proxies
 * report), replacing any copy the client sent: the x402 per-address limit
 * keys on it, never on a header the client controls.
 */
export const GATE_CLIENT_IP_HEADER = "X-Ingressi-Client-Ip";
/** Passed to the upstream after a successful gate decision (client copies are stripped). */
export const CONSUMER_ID_HEADER = "X-Ingressi-Consumer-Id";
export const PLAN_HEADER = "X-Ingressi-Plan";
/** Headers the gate vouches for; client-supplied copies never reach the upstream. */
export const GATE_IDENTITY_HEADERS = [CONSUMER_ID_HEADER, PLAN_HEADER] as const;
/** The family stripped with a wildcard as well (X-Ingressi-Consumer-*). */
export const CONSUMER_HEADER_PREFIX = "X-Ingressi-Consumer-";

export const GATE_PATH = "/api/monetization/gate";
export const WEBHOOK_PATH = "/api/monetization/stripe/webhook";
export const PORTAL_PATH = "/api-portal";

export const DEFAULT_KEY_HEADER = "Authorization";

export const CONSUMER_STATUSES = ["active", "disabled"] as const;
export type ConsumerStatus = (typeof CONSUMER_STATUSES)[number];

/**
 * topup: a Stripe Checkout top-up; usage: metered requests (one row per
 * consumer and UTC hour); adjustment: a manual change; credit: requests
 * credited back because their answer was a 5xx (one row per consumer and
 * hour); payment: a postpaid consumer's payment (a charge of the saved card,
 * or the open amount paid in Checkout); refund and dispute: money Stripe
 * gave back to the payer, taken off the balance.
 */
export const LEDGER_TYPES = ["topup", "usage", "adjustment", "credit", "payment", "refund", "dispute"] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];

/** How a consumer pays: prepaid balance, or usage charged to a saved card afterwards (postpaid). */
export const BILLING_MODES = ["prepaid", "postpaid"] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

/** Why a postpaid consumer's requests get 402 until something is paid or resumed. */
/**
 * Why a postpaid consumer is refused (402 payment_overdue): a charge failed,
 * the bank wants the card holder to confirm one, a payment is disputed, or
 * its billing is being switched away from postpaid (for the few seconds the
 * switch's charge takes, postpaid.ts switchBilling).
 */
export const SUSPENSION_REASONS = ["payment_failed", "authentication_required", "dispute", "billing_switch"] as const;
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];

/** A stored suspension reason; anything unknown reads as a failed charge. */
export function readSuspensionReason(value: unknown): SuspensionReason {
  return (SUSPENSION_REASONS as readonly unknown[]).includes(value) ? (value as SuspensionReason) : "payment_failed";
}

/** Header of a successful gate answer carrying the charge id that the access log records (failed-answer credits). */
export const CHARGE_HEADER = "X-Ingressi-Charge";
/** The access log field (log_append) holding that charge id. */
export const CHARGE_LOG_FIELD = "ingressi_charge";

/** x402's settlement answer header (x402/gate.ts), copied from the gate onto the response. */
export const X402_PAYMENT_RESPONSE_HEADER = "Payment-Response";
/** x402's payment request headers (version 2, and version 1's): never forwarded upstream, never logged. */
export const X402_PAYMENT_REQUEST_HEADERS = ["Payment-Signature", "X-Payment"] as const;

export const MAX_KEYS_PER_CONSUMER = 20;

export type PlanView = {
  id: number;
  name: string;
  pricePerRequestMicros: number;
  includedRequestsPerMonth: number;
  requestsPerMinute: number | null;
  /** How the plan's consumers pay, unless a consumer has its own billing. */
  billing: BillingMode;
  /** Postpaid: the most unpaid usage a consumer may run up (required for postpaid). */
  postpaidCapMicros: number | null;
  /** Postpaid: the card is charged when the unpaid usage reaches this (null: half the cap). */
  postpaidThresholdMicros: number | null;
  /** Requests answered with a 5xx are credited back (needs ClickHouse analytics). */
  creditFailedAnswers: boolean;
  /** Key holders on the plan may pay a request with x402 when their balance does not cover it. */
  acceptX402: boolean;
  consumerCount: number;
  createdAt: string;
  updatedAt: string;
};

export type ConsumerKeyView = {
  id: number;
  consumerId: number;
  name: string | null;
  /** Public part of the key, e.g. "ik_3f9a1c2b"; enough to recognise it, useless to call the API. */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type ConsumerView = {
  id: number;
  name: string;
  email: string | null;
  status: ConsumerStatus;
  planId: number | null;
  planName: string | null;
  /** Balance including usage not yet written to the ledger. */
  balanceMicros: number;
  overdraftAllowanceMicros: number;
  /** Free requests used this calendar month (UTC). */
  includedRequestsUsed: number;
  hasPortalLink: boolean;
  activeKeyCount: number;
  /** The consumer's own billing; null: the plan's. */
  billingOverride: BillingMode | null;
  /** In effect: the consumer's own, or the plan's. */
  billing: BillingMode;
  /** Postpaid: card, open amount, cap and state; null for prepaid consumers. */
  postpaid: PostpaidView | null;
  createdAt: string;
  updatedAt: string;
};

/** A saved card: brand and last four digits only. */
export type CardView = { brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null; expired: boolean };

export type PostpaidView = {
  /** Usage not paid yet (positive), including usage not yet written to the ledger. */
  openAmountMicros: number;
  /** Charges sent to Stripe whose outcome is not known yet. */
  pendingChargeMicros: number;
  capMicros: number;
  thresholdMicros: number;
  /** active: requests are served; needs_card: no valid card is saved; suspended: a payment failed or was disputed. */
  state: "active" | "needs_card" | "suspended";
  suspendedReason: SuspensionReason | null;
  suspendedAt: string | null;
  card: CardView | null;
  /** When the end-of-period charge runs (the 1st of next month, UTC). */
  nextPeriodChargeAt: string;
};

export type ConsumerDetailView = ConsumerView & { keys: ConsumerKeyView[]; payments: PaymentView[] };

/** A Stripe payment of a consumer: a top-up, a charge of the saved card, or an open amount paid in Checkout. */
export type PaymentView = {
  id: number;
  consumerId: number;
  kind: "topup" | "charge" | "open_amount";
  reason: string | null;
  status: "pending" | "succeeded" | "failed" | "requires_action" | "canceled";
  amountMicros: number;
  currency: string;
  period: string | null;
  paymentIntentId: string | null;
  failureCode: string | null;
  refundedMicros: number;
  disputedMicros: number;
  createdAt: string;
  updatedAt: string;
};

export type LedgerEntryView = {
  id: number;
  consumerId: number;
  consumerName: string | null;
  type: LedgerType;
  amountMicros: number;
  balanceAfterMicros: number;
  requests: number;
  freeRequests: number;
  reference: string | null;
  description: string | null;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
};

export type LedgerPage = { entries: LedgerEntryView[]; total: number; page: number; perPage: number };

export type HostMonetizationView = {
  proxyHostId: number;
  name: string;
  domains: string[];
  hostEnabled: boolean;
  monetization: {
    enabled: boolean;
    keyHeader: string;
    allowedPlanIds: number[];
    x402: HostX402View;
  } | null;
  /** Authentication modes on the host that rule out monetization. */
  conflicts: string[];
};

export type StripeSettingsView = {
  /** Both Stripe secrets are stored: consumers can top up. */
  configured: boolean;
  hasSecretKey: boolean;
  hasWebhookSecret: boolean;
  /** From the secret key's prefix; null without one. */
  mode: "live" | "test" | null;
  /** ISO 4217, lower case, as Stripe writes it. */
  currency: string;
  topUpAmountsMicros: number[];
  /** Where the 402 response and its Link header send consumers; null: the built-in portal page. */
  topUpUrl: string | null;
  /** The endpoint to register in Stripe (Developers → Webhooks). */
  webhookUrl: string;
  webhookEvents: string[];
  /** Stripe Tax on Checkout (top-ups and open amounts): Stripe computes tax on top of the amount; off-session charges carry none. */
  automaticTax: boolean;
  /** Only in the answer to a save or removal that replaced or removed the secret key while x402 was set up: x402 was turned off and its deposit address cleared. */
  x402TurnedOff?: boolean;
};

export type HostX402View = {
  enabled: boolean;
  /** The host's price per request in US cents; null: the x402 settings' price. */
  priceCents: number | null;
};

/** The events to send to the webhook endpoint (Stripe → Developers → Webhooks). */
export const STRIPE_WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "setup_intent.succeeded",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "charge.refunded",
  "charge.dispute.created",
] as const;

/** Ledger totals of one calendar month (UTC). Amounts are positive micro-units. */
export type MonetizationMonthTotals = {
  /** The month's first day, "YYYY-MM-01". */
  month: string;
  /** Paid in through Stripe in the month (top-ups and postpaid payments), and how many of each. */
  paidInMicros: number;
  topUps: number;
  /** Postpaid payments (charges of saved cards, open amounts paid in Checkout). */
  payments: number;
  /** Refunded or disputed in the month (taken off balances). */
  refundedMicros: number;
  /** What metered requests cost the consumers in the month, after failed-answer credits. */
  chargedMicros: number;
  /** Credited back for requests answered with a 5xx, and how many requests. */
  creditedMicros: number;
  creditedRequests: number;
  /** Every metered request: charged ones plus free ones (the plan's monthly allowance). */
  requests: number;
  chargedRequests: number;
  freeRequests: number;
  /** Net of manual balance adjustments (negative when more was taken off than added), and how many. */
  adjustmentsMicros: number;
  adjustments: number;
};

/** One UTC day of the last 30 (oldest first). */
export type MonetizationDay = {
  /** "YYYY-MM-DD". */
  day: string;
  requests: number;
  chargedRequests: number;
  freeRequests: number;
  chargedMicros: number;
  paidInMicros: number;
};

/** One consumer's metered usage this month, and when its keys were last used. */
export type MonetizationConsumerUsage = {
  consumerId: number;
  requests: number;
  chargedRequests: number;
  freeRequests: number;
  chargedMicros: number;
  /** Latest use of any of its keys (written every few minutes at most). */
  keysLastUsedAt: string | null;
  revokedKeys: number;
  lastRevokedAt: string | null;
  /** The balance was ever topped up or raised by an adjustment. */
  funded: boolean;
};

export type MonetizationTopConsumer = {
  consumerId: number;
  /** Null for a deleted consumer. */
  name: string | null;
  planName: string | null;
  requests: number;
  chargedMicros: number;
  /** Share of the month's metered requests, 0–1. */
  share: number;
};

/** The overview tab: month totals, the last 30 days and top consumers from the ledger, and the balances held. */
export type MonetizationOverview = {
  currency: string;
  /** When it was computed; the current month and day run to this moment. */
  generatedAt: string;
  thisMonth: MonetizationMonthTotals;
  previousMonth: MonetizationMonthTotals;
  days: MonetizationDay[];
  /** This month, most requests first. */
  topConsumers: MonetizationTopConsumer[];
  /** This month, for every consumer with usage, keys or a top-up. */
  consumers: MonetizationConsumerUsage[];
  /** Balances as the gate sees them (including usage not yet written to the ledger). */
  balances: {
    consumers: number;
    /** Sum of the positive balances: prepaid money not yet used. */
    heldMicros: number;
    heldFor: number;
    heldForDisabled: number;
    /** Sum of the negative balances of prepaid consumers (as a positive amount): used through the overdraft allowance. */
    overdrawnMicros: number;
    overdrawn: number;
    /** Usage postpaid consumers have not paid yet, and how many owe something. */
    postpaidOpenMicros: number;
    postpaidOpen: number;
  };
  lastTopUp: { consumerId: number; consumerName: string | null; amountMicros: number; at: string } | null;
  /** This month's x402 payments (x402/payments.ts). */
  x402: MonetizationX402Summary;
};

export type MonetizationX402Summary = {
  /** Recorded by Stripe (in the operator's Stripe balance). */
  settled: number;
  failed: number;
  /** Settled on chain, or of unknown outcome, and not recorded by Stripe yet: the operator looks at them. */
  pending: number;
  /** What the recorded payments came to, in US cents. */
  amountCents: number;
};

/** Install-wide options (settings key "monetization_options"). */
export type MonetizationOptionsView = {
  /** Hourly usage and credit rows older than this many months are deleted (top-ups, payments and adjustments are kept). */
  usageRetentionMonths: number;
  /** How sync replicas and pull replicas serve monetized hosts: not at all, through shared state, or with allowances from this master's gate. */
  replicas: {
    mode: ReplicaMode;
    /** Where replicas reach this master's gate (allowance mode); null: BASE_URL. */
    gateUrl: string | null;
    /** Why the mode cannot be used now (shared mode without shared state, say); null when it can. */
    problem: string | null;
  };
  /** ClickHouse analytics is configured, so failed-answer credits can be offered. */
  analyticsAvailable: boolean;
};

export const REPLICA_MODES = ["off", "shared", "allowance"] as const;
export type ReplicaMode = (typeof REPLICA_MODES)[number];

export const MONETIZATION_TABS = ["overview", "plans", "consumers", "hosts", "stripe", "x402", "settings", "ledger"] as const;
export type MonetizationTab = (typeof MONETIZATION_TABS)[number];
