// SPDX-License-Identifier: Elastic-2.0
/**
 * OpenAPI paths and schemas of the API monetization endpoints, spread into
 * app/api/v1/openapi.json/route.ts.
 */

const TAG = "API Monetization";

export const MONETIZATION_OPENAPI_TAG = {
  name: TAG,
  description:
    "Per-request billing of the consumers of APIs behind monetized proxy hosts, prepaid (topped up) or postpaid (a saved card " +
    "charged afterwards, up to a hard cap), through your Stripe account, and x402 pay-per-request (Enterprise edition). Amounts " +
    "are integer micro-units of the install's currency (1 USD = 1,000,000). Creating and changing plans, consumers, keys, " +
    "balances, host monetization, Stripe, x402 and replica settings need the api_monetization feature; deleting, disabling and " +
    "revoking never do, and nothing at request time (gate, payments, webhooks, consumer API, billing) checks the license.",
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ "application/json": { schema } });
const idParam = { $ref: "#/components/parameters/IdPath" };
const errors = (...codes: string[]) => {
  const map: Record<string, unknown> = {
    "400": { $ref: "#/components/responses/BadRequest" },
    "401": { $ref: "#/components/responses/Unauthorized" },
    "403": { $ref: "#/components/responses/Forbidden" },
    "404": { $ref: "#/components/responses/NotFound" },
    "409": { $ref: "#/components/responses/Conflict" },
  };
  return Object.fromEntries(codes.map((code) => [code, map[code]]));
};

export const MONETIZATION_OPENAPI_PATHS = {
  "/api/v1/monetization/plans": {
    get: {
      tags: [TAG],
      summary: "List plans",
      description: "Permission monetization:read. Available without a license.",
      operationId: "listMonetizationPlans",
      responses: { "200": { description: "Plans", content: json({ type: "array", items: ref("MonetizationPlan") }) }, ...errors("401", "403") },
    },
    post: {
      tags: [TAG],
      summary: "Create a plan",
      description: "Permission monetization:write; needs the api_monetization feature (403 otherwise). 409 for a duplicate name.",
      operationId: "createMonetizationPlan",
      requestBody: { required: true, content: json(ref("MonetizationPlanInput")) },
      responses: { "201": { description: "Created", content: json(ref("MonetizationPlan")) }, ...errors("400", "401", "403", "409") },
    },
  },
  "/api/v1/monetization/plans/{id}": {
    get: {
      tags: [TAG],
      summary: "Get a plan",
      operationId: "getMonetizationPlan",
      parameters: [idParam],
      responses: { "200": { description: "Plan", content: json(ref("MonetizationPlan")) }, ...errors("401", "403", "404") },
    },
    put: {
      tags: [TAG],
      summary: "Update a plan",
      description: "Fields left out keep their values. Needs the api_monetization feature. Takes effect on the next request.",
      operationId: "updateMonetizationPlan",
      parameters: [idParam],
      requestBody: { required: true, content: json(ref("MonetizationPlanUpdate")) },
      responses: { "200": { description: "Updated", content: json(ref("MonetizationPlan")) }, ...errors("400", "401", "403", "404", "409") },
    },
    delete: {
      tags: [TAG],
      summary: "Delete a plan",
      description: "Works without a license. 409 while consumers are on the plan or a monetized host lists it.",
      operationId: "deleteMonetizationPlan",
      parameters: [idParam],
      responses: { "204": { description: "Deleted" }, ...errors("401", "403", "404", "409") },
    },
  },
  "/api/v1/monetization/consumers": {
    get: {
      tags: [TAG],
      summary: "List consumers",
      description: "Balances include usage the gate counted but has not written to the ledger yet.",
      operationId: "listMonetizationConsumers",
      responses: { "200": { description: "Consumers", content: json({ type: "array", items: ref("MonetizationConsumer") }) }, ...errors("401", "403") },
    },
    post: {
      tags: [TAG],
      summary: "Create a consumer",
      description: "Needs the api_monetization feature. The balance starts at 0: top it up through Stripe or adjust it.",
      operationId: "createMonetizationConsumer",
      requestBody: { required: true, content: json(ref("MonetizationConsumerInput")) },
      responses: { "201": { description: "Created", content: json(ref("MonetizationConsumerDetail")) }, ...errors("400", "401", "403") },
    },
  },
  "/api/v1/monetization/consumers/{id}": {
    get: {
      tags: [TAG],
      summary: "Get a consumer with its keys",
      operationId: "getMonetizationConsumer",
      parameters: [idParam],
      responses: { "200": { description: "Consumer", content: json(ref("MonetizationConsumerDetail")) }, ...errors("401", "403", "404") },
    },
    put: {
      tags: [TAG],
      summary: "Update a consumer",
      description:
        "Fields left out keep their values. Needs the api_monetization feature, except a body that only disables the consumer " +
        "({\"status\": \"disabled\"}), which works without a license. A disabled consumer's requests get 403 at once.",
      operationId: "updateMonetizationConsumer",
      parameters: [idParam],
      requestBody: { required: true, content: json(ref("MonetizationConsumerUpdate")) },
      responses: { "200": { description: "Updated", content: json(ref("MonetizationConsumerDetail")) }, ...errors("400", "401", "403", "404") },
    },
    delete: {
      tags: [TAG],
      summary: "Delete a consumer",
      description: "Deletes the consumer and its keys after writing its pending usage; its ledger entries are kept. Works without a license.",
      operationId: "deleteMonetizationConsumer",
      parameters: [idParam],
      responses: { "204": { description: "Deleted" }, ...errors("401", "403", "404") },
    },
  },
  "/api/v1/monetization/consumers/{id}/keys": {
    get: {
      tags: [TAG],
      summary: "List a consumer's API keys",
      description: "Prefixes only; keys are never shown again after creation.",
      operationId: "listMonetizationConsumerKeys",
      parameters: [idParam],
      responses: { "200": { description: "Keys", content: json({ type: "array", items: ref("MonetizationConsumerKey") }) }, ...errors("401", "403", "404") },
    },
    post: {
      tags: [TAG],
      summary: "Create an API key",
      description:
        "Returns the key once (rawKey); only its SHA-256 and public prefix are stored. At most 20 active keys per consumer (409). " +
        "Needs the api_monetization feature.",
      operationId: "createMonetizationConsumerKey",
      parameters: [idParam],
      requestBody: { required: false, content: json(ref("MonetizationConsumerKeyInput")) },
      responses: { "201": { description: "Created", content: json(ref("MonetizationConsumerKeyCreated")) }, ...errors("400", "401", "403", "404", "409") },
    },
  },
  "/api/v1/monetization/consumers/{id}/keys/{keyId}": {
    delete: {
      tags: [TAG],
      summary: "Revoke an API key",
      description: "The key stops working at once. Works without a license; revoking a revoked key is a no-op.",
      operationId: "revokeMonetizationConsumerKey",
      parameters: [idParam, { name: "keyId", in: "path", required: true, schema: { type: "integer" } }],
      responses: { "204": { description: "Revoked" }, ...errors("401", "403", "404") },
    },
  },
  "/api/v1/monetization/consumers/{id}/adjust": {
    post: {
      tags: [TAG],
      summary: "Adjust a consumer's balance",
      description:
        "Adds amountMicros (negative to take money off) with a reason, as an adjustment ledger entry. A reference makes the call safe " +
        "to retry: the same reference again answers 409. Needs the api_monetization feature.",
      operationId: "adjustMonetizationConsumerBalance",
      parameters: [idParam],
      requestBody: { required: true, content: json(ref("MonetizationAdjustmentInput")) },
      responses: { "201": { description: "Adjusted", content: json(ref("MonetizationAdjustmentResult")) }, ...errors("400", "401", "403", "404", "409") },
    },
  },
  "/api/v1/monetization/consumers/{id}/billing/charge": {
    post: {
      tags: [TAG],
      summary: "Charge a postpaid consumer's open amount now",
      description:
        "Charges the saved card off-session for the open amount (less charges on their way), rounded down to the currency's " +
        "smallest unit. status: succeeded, pending (Stripe has not answered; reconciled later), failed (the consumer is suspended " +
        "until it pays) or skipped (with the reason: not postpaid, no card, suspended, nothing to charge, below Stripe's minimum). " +
        "Collects what is owed: works without a license. 502 when Stripe cannot be reached.",
      operationId: "chargeMonetizationConsumer",
      parameters: [idParam],
      responses: { "200": { description: "Outcome", content: json(ref("MonetizationChargeOutcome")) }, ...errors("401", "403", "404") },
    },
  },
  "/api/v1/monetization/consumers/{id}/billing/resume": {
    post: {
      tags: [TAG],
      summary: "Resume a suspended postpaid consumer",
      description:
        "Ends a suspension (a failed charge, or a disputed payment, which only an administrator ends). Needs the api_monetization " +
        "feature. A suspension for a failed charge also ends by itself when the open amount is paid.",
      operationId: "resumeMonetizationConsumer",
      parameters: [idParam],
      responses: { "200": { description: "Consumer", content: json(ref("MonetizationConsumerDetail")) }, ...errors("401", "403", "404") },
    },
  },
  "/api/v1/monetization/consumers/{id}/billing/card": {
    delete: {
      tags: [TAG],
      summary: "Remove a postpaid consumer's saved card",
      description: "Forgets the card and detaches it in Stripe; the consumer's requests get 402 until it saves a new one. Works without a license.",
      operationId: "removeMonetizationConsumerCard",
      parameters: [idParam],
      responses: { "204": { description: "Removed" }, ...errors("401", "403", "404") },
    },
  },
  "/api/v1/monetization/payments": {
    get: {
      tags: [TAG],
      summary: "List Stripe payments",
      description: "Top-ups, postpaid charges and open amounts paid in Checkout, newest first, with refunds and disputes.",
      operationId: "listMonetizationPayments",
      parameters: [
        { name: "consumerId", in: "query", schema: { type: "integer" } },
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 50 } },
      ],
      responses: { "200": { description: "Payments", content: json({ type: "array", items: ref("MonetizationPayment") }) }, ...errors("400", "401", "403") },
    },
  },
  "/api/v1/monetization/settings": {
    get: {
      tags: [TAG],
      summary: "Get the monetization options",
      description: "Usage history retention, how sync replicas serve monetized hosts, and whether failed-answer credits are available.",
      operationId: "getMonetizationOptions",
      responses: { "200": { description: "Options", content: json(ref("MonetizationOptions")) }, ...errors("401", "403") },
    },
    put: {
      tags: [TAG],
      summary: "Change the monetization options",
      description:
        "Fields left out keep their values. Needs the api_monetization feature, except turning replica serving off. Changing replicas " +
        "also needs instances:write (it decides what replicas receive and where they send their allowance credential). replicas.mode " +
        "\"shared\" needs high availability shared state on this instance, \"allowance\" an https gate URL (gateUrl, or BASE_URL; " +
        "http only with INSTANCE_SYNC_ALLOW_HTTP=true): 400 otherwise. Changing the mode sends the configuration to the replicas again.",
      operationId: "saveMonetizationOptions",
      requestBody: { required: true, content: json(ref("MonetizationOptionsInput")) },
      responses: { "200": { description: "Options", content: json(ref("MonetizationOptions")) }, ...errors("400", "401", "403") },
    },
  },
  "/api/v1/monetization/x402": {
    get: {
      tags: [TAG],
      summary: "Get the x402 settings",
      description: "On, the price per request, the network (Base), the Stripe deposit address payments go to, the CDP API key id, and whether Stripe has Stablecoins and Crypto enabled. The CDP key secret is never returned (hasCdpKeySecret).",
      operationId: "getMonetizationX402Settings",
      responses: { "200": { description: "Settings", content: json(ref("MonetizationX402Settings")) }, ...errors("401", "403") },
    },
    put: {
      tags: [TAG],
      summary: "Save the x402 settings",
      description:
        "Permission monetization:payments (where payments go). Fields left out keep their values; an omitted or empty cdpKeySecret " +
        "keeps the stored one (encrypted). Turning x402 on needs the CDP API key id and secret and Stripe set up: it creates the " +
        "Stripe crypto deposit address (POST /v1/crypto/deposit_addresses, network base) when there is none for the current key yet; it needs a live Stripe key (409 with a test key). 409 when Stripe " +
        "has not enabled Stablecoins and Crypto on the account (request it in the Stripe Dashboard; outside the US, email " +
        "machine-payments@stripe.com), when Stripe is not set up or cannot be reached, or refuses. A cdpKeySecret that cannot sign " +
        "the facilitator's tokens is refused (400); nothing is sent to the facilitator. Needs the api_monetization feature.",
      operationId: "saveMonetizationX402Settings",
      requestBody: { required: true, content: json(ref("MonetizationX402SettingsInput")) },
      responses: { "200": { description: "Saved", content: json(ref("MonetizationX402Settings")) }, ...errors("400", "401", "403", "409") },
    },
    delete: {
      tags: [TAG],
      summary: "Turn x402 off",
      description: "Turns x402 off and removes the CDP key secret (the deposit address is kept). Works without a license.",
      operationId: "removeMonetizationX402Settings",
      responses: { "200": { description: "Turned off", content: json(ref("MonetizationX402Settings")) }, ...errors("401", "403") },
    },
  },
  "/api/v1/monetization/x402/payments": {
    get: {
      tags: [TAG],
      summary: "List x402 payments",
      description: "Newest first: payer address, amount, settlement transaction, the Stripe PaymentIntent that records it, and state.",
      operationId: "listMonetizationX402Payments",
      parameters: [
        { name: "hostId", in: "query", schema: { type: "integer" } },
        { name: "status", in: "query", schema: { type: "string", enum: ["verifying", "settling", "recording", "confirmed", "settled", "unrecorded", "unknown", "failed"] } },
        { name: "page", in: "query", schema: { type: "integer", minimum: 1 } },
        { name: "perPage", in: "query", schema: { type: "integer", minimum: 1, maximum: 200 } },
      ],
      responses: { "200": { description: "Payments", content: json(ref("MonetizationX402PaymentPage")) }, ...errors("400", "401", "403") },
    },
  },
  "/api/v1/monetization/consumers/{id}/portal-link": {
    post: {
      tags: [TAG],
      summary: "Issue a new portal link",
      description:
        "Creates the consumer's self-service portal link (balance, recent usage, top-ups); the previous link stops working. The link " +
        "is in this response only (its token is stored hashed). Needs the api_monetization feature.",
      operationId: "rotateMonetizationPortalLink",
      parameters: [idParam],
      responses: { "201": { description: "Issued", content: json(ref("MonetizationPortalLink")) }, ...errors("401", "403", "404") },
    },
    delete: {
      tags: [TAG],
      summary: "Turn the portal link off",
      description: "Works without a license.",
      operationId: "revokeMonetizationPortalLink",
      parameters: [idParam],
      responses: { "204": { description: "Turned off" }, ...errors("401", "403", "404") },
    },
  },
  "/api/v1/monetization/hosts": {
    get: {
      tags: [TAG],
      summary: "List proxy hosts with their monetization",
      description: "Every proxy host, its monetization settings (null when never set) and the authentication modes that rule it out.",
      operationId: "listMonetizationHosts",
      responses: { "200": { description: "Hosts", content: json({ type: "array", items: ref("MonetizationHost") }) }, ...errors("401", "403") },
    },
  },
  "/api/v1/monetization/hosts/{id}": {
    get: {
      tags: [TAG],
      summary: "Get a proxy host's monetization",
      operationId: "getMonetizationHost",
      parameters: [idParam],
      responses: { "200": { description: "Host", content: json(ref("MonetizationHost")) }, ...errors("401", "403", "404") },
    },
    put: {
      tags: [TAG],
      summary: "Turn monetization on, change or turn it off",
      description:
        "Turning it on or changing it needs the api_monetization feature (403), an instance that is not a sync replica and not " +
        "one of several replicas on one PostgreSQL database without shared state (409), and a host without forward auth (built-in, " +
        "Authentik or generic) or a basic-auth access list (400). {\"enabled\": false} works without a license. Re-applies the " +
        "Caddy configuration.",
      operationId: "setMonetizationHost",
      parameters: [idParam],
      requestBody: { required: true, content: json(ref("MonetizationHostInput")) },
      responses: { "200": { description: "Saved", content: json(ref("MonetizationHost")) }, ...errors("400", "401", "403", "404", "409") },
    },
    delete: {
      tags: [TAG],
      summary: "Turn monetization off and forget the host's settings",
      description: "Works without a license. Re-applies the Caddy configuration.",
      operationId: "deleteMonetizationHost",
      parameters: [idParam],
      responses: { "204": { description: "Removed" }, ...errors("401", "403", "404") },
    },
  },
  "/api/v1/monetization/stripe": {
    get: {
      tags: [TAG],
      summary: "Get the Stripe settings",
      description: "The secret key and webhook signing secret are never returned (hasSecretKey, hasWebhookSecret).",
      operationId: "getMonetizationStripeSettings",
      responses: { "200": { description: "Settings", content: json(ref("MonetizationStripeSettings")) }, ...errors("401", "403") },
    },
    put: {
      tags: [TAG],
      summary: "Save the Stripe settings",
      description:
        "Omitted or empty secrets keep the stored ones; secrets are stored encrypted. The currency cannot change while a consumer " +
        "has a non-zero balance (409). A secret key other than the stored one turns x402 off and clears its deposit address (it " +
        "belonged to the old key's account and mode); the answer then has x402TurnedOff. Needs the api_monetization feature.",
      operationId: "saveMonetizationStripeSettings",
      requestBody: { required: true, content: json(ref("MonetizationStripeSettingsInput")) },
      responses: { "200": { description: "Saved", content: json(ref("MonetizationStripeSettings")) }, ...errors("400", "401", "403", "409") },
    },
    delete: {
      tags: [TAG],
      summary: "Remove the Stripe keys",
      description:
        "Top-ups stop; balances, metering and the currency stay. x402 is turned off and its deposit address cleared (x402TurnedOff). " +
        "Works without a license.",
      operationId: "removeMonetizationStripeSettings",
      responses: { "200": { description: "Removed", content: json(ref("MonetizationStripeSettings")) }, ...errors("401", "403") },
    },
  },
  "/api/v1/monetization/overview": {
    get: {
      tags: [TAG],
      summary: "Get the overview",
      description:
        "Permission monetization:read. Available without a license. Computed from the ledger: this and last calendar month's totals " +
        "(UTC), the last 30 UTC days (today up to now), this month's top consumers by metered requests and each consumer's usage this " +
        "month, plus the balances held (including usage the gate counted but has not written to the ledger yet). Amounts are positive " +
        "micro-units: what was charged, not ledger signs.",
      operationId: "getMonetizationOverview",
      responses: { "200": { description: "Overview", content: json(ref("MonetizationOverview")) }, ...errors("401", "403") },
    },
  },
  "/api/v1/monetization/ledger": {
    get: {
      tags: [TAG],
      summary: "List ledger entries",
      description:
        "Newest first. Usage and failed-answer credits are one entry per consumer and UTC hour, updated while requests come in; " +
        "top-ups and open amounts paid in Checkout carry the reference stripe:<checkout session id>, postpaid charges " +
        "stripe-pi:<PaymentIntent id>, refunds stripe-refund:<charge>:<total>, disputes stripe-dispute:<dispute id>.",
      operationId: "listMonetizationLedger",
      parameters: [
        { name: "consumerId", in: "query", schema: { type: "integer" } },
        { name: "type", in: "query", schema: { type: "string", enum: ["topup", "usage", "adjustment", "credit", "payment", "refund", "dispute"] } },
        { name: "page", in: "query", schema: { type: "integer", minimum: 1 } },
        { name: "perPage", in: "query", schema: { type: "integer", minimum: 1, maximum: 200 } },
      ],
      responses: { "200": { description: "Entries", content: json(ref("MonetizationLedgerPage")) }, ...errors("400", "401", "403") },
    },
  },
};

const micros = (description: string) => ({ type: "integer", description: `${description} (micro-units: 1 USD = 1,000,000)` });
const timestamp = { type: "string", format: "date-time" };

const PLAN_BILLING_PROPERTIES = {
  billing: { type: "string", enum: ["prepaid", "postpaid"], description: "How the plan's consumers pay unless a consumer has its own billing" },
  postpaidCapMicros: {
    type: ["integer", "null"],
    minimum: 1,
    maximum: 10_000_000_000,
    description: "Postpaid: the most unpaid usage a consumer may run up (required for postpaid; at most 10,000 units)",
  },
  postpaidThresholdMicros: { type: ["integer", "null"], minimum: 1, description: "Postpaid: charge the card when the open amount reaches this; null: half the cap" },
  creditFailedAnswers: { type: "boolean", description: "Credit back requests answered with a 5xx (needs ClickHouse analytics to turn on: 409 otherwise)" },
  acceptX402: { type: "boolean", description: "Key holders on the plan may pay a request with x402 when their balance does not cover it" },
};

export const MONETIZATION_OPENAPI_SCHEMAS = {
  MonetizationPlan: {
    type: "object",
    properties: {
      id: { type: "integer" },
      name: { type: "string" },
      pricePerRequestMicros: micros("Price of one request"),
      includedRequestsPerMonth: { type: "integer", description: "Free requests per calendar month (UTC), used before the balance" },
      requestsPerMinute: { type: ["integer", "null"], description: "Per-minute limit per consumer (429 beyond it); null for none" },
      ...PLAN_BILLING_PROPERTIES,
      consumerCount: { type: "integer" },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    required: [
      "id", "name", "pricePerRequestMicros", "includedRequestsPerMonth", "requestsPerMinute", "billing", "postpaidCapMicros",
      "postpaidThresholdMicros", "creditFailedAnswers", "acceptX402", "consumerCount", "createdAt", "updatedAt",
    ],
  },
  MonetizationPlanInput: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", maxLength: 100 },
      pricePerRequestMicros: micros("Price of one request"),
      includedRequestsPerMonth: { type: "integer", minimum: 0 },
      requestsPerMinute: { type: ["integer", "null"], minimum: 1 },
      ...PLAN_BILLING_PROPERTIES,
    },
    required: ["name", "pricePerRequestMicros"],
  },
  MonetizationPlanUpdate: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", maxLength: 100 },
      pricePerRequestMicros: micros("Price of one request"),
      includedRequestsPerMonth: { type: "integer", minimum: 0 },
      requestsPerMinute: { type: ["integer", "null"], minimum: 1 },
      ...PLAN_BILLING_PROPERTIES,
    },
  },
  MonetizationConsumer: {
    type: "object",
    properties: {
      id: { type: "integer" },
      name: { type: "string" },
      email: { type: ["string", "null"] },
      status: { type: "string", enum: ["active", "disabled"] },
      planId: { type: ["integer", "null"] },
      planName: { type: ["string", "null"] },
      balanceMicros: micros("Balance, including usage not yet written to the ledger"),
      overdraftAllowanceMicros: micros("How far below zero the balance may go (0: strictly prepaid)"),
      includedRequestsUsed: { type: "integer", description: "Free requests used this calendar month" },
      hasPortalLink: { type: "boolean" },
      activeKeyCount: { type: "integer" },
      billingOverride: { type: ["string", "null"], enum: ["prepaid", "postpaid", null], description: "The consumer's own billing; null: the plan's" },
      billing: { type: "string", enum: ["prepaid", "postpaid"], description: "The billing in effect" },
      postpaid: { oneOf: [ref("MonetizationPostpaid"), { type: "null" }] },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    required: [
      "id", "name", "email", "status", "planId", "planName", "balanceMicros", "overdraftAllowanceMicros", "includedRequestsUsed",
      "hasPortalLink", "activeKeyCount", "billingOverride", "billing", "postpaid", "createdAt", "updatedAt",
    ],
  },
  MonetizationPostpaid: {
    type: "object",
    description: "A postpaid consumer's open amount, cap, card and state.",
    properties: {
      openAmountMicros: micros("Usage not paid yet, including usage not yet written to the ledger"),
      pendingChargeMicros: micros("Charges sent to Stripe whose outcome is not known yet"),
      capMicros: micros("The plan's cap: requests past it get 402"),
      thresholdMicros: micros("The card is charged when the open amount reaches this"),
      state: { type: "string", enum: ["active", "needs_card", "suspended"] },
      suspendedReason: { type: ["string", "null"], enum: ["payment_failed", "authentication_required", "dispute", "billing_switch", null] },
      suspendedAt: { type: ["string", "null"], format: "date-time" },
      card: {
        oneOf: [
          {
            type: "object",
            description: "Brand, last four digits and expiry only",
            properties: {
              brand: { type: ["string", "null"] },
              last4: { type: ["string", "null"] },
              expMonth: { type: ["integer", "null"] },
              expYear: { type: ["integer", "null"] },
              expired: { type: "boolean" },
            },
            required: ["brand", "last4", "expMonth", "expYear", "expired"],
          },
          { type: "null" },
        ],
      },
      nextPeriodChargeAt: { ...timestamp, description: "The next end-of-period charge (the 1st of next month, UTC)" },
    },
    required: ["openAmountMicros", "pendingChargeMicros", "capMicros", "thresholdMicros", "state", "suspendedReason", "suspendedAt", "card", "nextPeriodChargeAt"],
  },
  MonetizationPayment: {
    type: "object",
    properties: {
      id: { type: "integer" },
      consumerId: { type: "integer" },
      kind: { type: "string", enum: ["topup", "charge", "open_amount"] },
      reason: { type: ["string", "null"], description: "Charges: threshold, period, expiry, manual or billing_switch" },
      status: { type: "string", enum: ["pending", "succeeded", "failed", "requires_action", "canceled"] },
      amountMicros: micros("Amount"),
      currency: { type: "string" },
      period: { type: ["string", "null"], description: "YYYY-MM of an end-of-period charge" },
      paymentIntentId: { type: ["string", "null"] },
      failureCode: { type: ["string", "null"] },
      refundedMicros: micros("Refunded so far"),
      disputedMicros: micros("Disputed"),
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    required: [
      "id", "consumerId", "kind", "reason", "status", "amountMicros", "currency", "period", "paymentIntentId", "failureCode",
      "refundedMicros", "disputedMicros", "createdAt", "updatedAt",
    ],
  },
  MonetizationChargeOutcome: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["succeeded", "pending", "failed", "skipped"] },
      paymentId: { type: "integer" },
      amountMicros: { type: "integer" },
      code: { type: ["string", "null"], description: "failed: Stripe's code" },
      reason: { type: "string", description: "skipped: why" },
    },
    required: ["status"],
  },
  MonetizationOptions: {
    type: "object",
    properties: {
      usageRetentionMonths: { type: "integer", minimum: 1, maximum: 120, description: "Hourly usage and credit history older than this is deleted" },
      replicas: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["off", "shared", "allowance"] },
          gateUrl: { type: ["string", "null"], description: "Where pushed replicas reach this gate (allowance); null: BASE_URL" },
          problem: { type: ["string", "null"], description: "Why the mode cannot be used now" },
        },
        required: ["mode", "gateUrl", "problem"],
      },
      analyticsAvailable: { type: "boolean", description: "ClickHouse is configured: failed-answer credits can be offered" },
    },
    required: ["usageRetentionMonths", "replicas", "analyticsAvailable"],
  },
  MonetizationOptionsInput: {
    type: "object",
    additionalProperties: false,
    properties: {
      usageRetentionMonths: { type: "integer", minimum: 1, maximum: 120 },
      replicas: {
        type: "object",
        additionalProperties: false,
        properties: { mode: { type: "string", enum: ["off", "shared", "allowance"] }, gateUrl: { type: ["string", "null"] } },
      },
    },
  },
  MonetizationConsumerDetail: {
    allOf: [
      ref("MonetizationConsumer"),
      {
        type: "object",
        properties: {
          keys: { type: "array", items: ref("MonetizationConsumerKey") },
          payments: { type: "array", items: ref("MonetizationPayment"), description: "The 20 most recent" },
        },
        required: ["keys", "payments"],
      },
    ],
  },
  MonetizationConsumerInput: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", maxLength: 100 },
      email: { type: ["string", "null"], maxLength: 254 },
      status: { type: "string", enum: ["active", "disabled"], default: "active" },
      planId: { type: ["integer", "null"] },
      overdraftAllowanceMicros: { ...micros("How far below zero the balance may go (prepaid)"), default: 0 },
      billing: { type: ["string", "null"], enum: ["prepaid", "postpaid", null], description: "The consumer's own billing; null: the plan's. Postpaid needs a plan with a cap." },
    },
    required: ["name"],
  },
  MonetizationConsumerUpdate: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", maxLength: 100 },
      email: { type: ["string", "null"], maxLength: 254 },
      status: { type: "string", enum: ["active", "disabled"] },
      planId: { type: ["integer", "null"] },
      overdraftAllowanceMicros: micros("How far below zero the balance may go (prepaid)"),
      billing: {
        type: ["string", "null"],
        enum: ["prepaid", "postpaid", null],
        description: "Switching between prepaid and postpaid settles first: 409 while the consumer owes an amount or a charge is on its way",
      },
    },
  },
  MonetizationConsumerKey: {
    type: "object",
    properties: {
      id: { type: "integer" },
      consumerId: { type: "integer" },
      name: { type: ["string", "null"] },
      prefix: { type: "string", description: "Public part of the key, e.g. ik_3f9a1c2b0d4e" },
      createdAt: timestamp,
      lastUsedAt: { type: ["string", "null"], format: "date-time" },
      revokedAt: { type: ["string", "null"], format: "date-time" },
    },
    required: ["id", "consumerId", "name", "prefix", "createdAt", "lastUsedAt", "revokedAt"],
  },
  MonetizationConsumerKeyInput: {
    type: "object",
    additionalProperties: false,
    properties: { name: { type: "string", maxLength: 100 } },
  },
  MonetizationConsumerKeyCreated: {
    type: "object",
    properties: {
      key: ref("MonetizationConsumerKey"),
      rawKey: { type: "string", description: "The API key; shown only in this response" },
    },
    required: ["key", "rawKey"],
  },
  MonetizationAdjustmentInput: {
    type: "object",
    additionalProperties: false,
    properties: {
      amountMicros: micros("Amount to add; negative to take off"),
      reason: { type: "string", maxLength: 500 },
      reference: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,100}$", description: "Optional idempotency reference" },
    },
    required: ["amountMicros", "reason"],
  },
  MonetizationAdjustmentResult: {
    type: "object",
    properties: { entry: ref("MonetizationLedgerEntry"), balanceMicros: micros("Balance after the adjustment") },
    required: ["entry", "balanceMicros"],
  },
  MonetizationPortalLink: {
    type: "object",
    properties: {
      url: { type: "string", description: "The portal link; shown only in this response" },
      token: { type: "string" },
    },
    required: ["url", "token"],
  },
  MonetizationHost: {
    type: "object",
    properties: {
      proxyHostId: { type: "integer" },
      name: { type: "string" },
      domains: { type: "array", items: { type: "string" } },
      hostEnabled: { type: "boolean" },
      monetization: {
        oneOf: [
          {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              keyHeader: { type: "string" },
              allowedPlanIds: { type: "array", items: { type: "integer" } },
              x402: ref("MonetizationHostX402"),
            },
            required: ["enabled", "keyHeader", "allowedPlanIds", "x402"],
          },
          { type: "null" },
        ],
      },
      conflicts: { type: "array", items: { type: "string" }, description: "Authentication modes on the host that rule monetization out" },
    },
    required: ["proxyHostId", "name", "domains", "hostEnabled", "monetization", "conflicts"],
  },
  MonetizationHostInput: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean", default: true },
      keyHeader: {
        type: "string",
        default: "Authorization",
        description: "Header carrying the consumer's key: Authorization (as Bearer <key>) or e.g. X-API-Key",
      },
      allowedPlanIds: { type: "array", items: { type: "integer" }, description: "Plans allowed on the host; empty for every plan" },
      x402: {
        type: "object",
        additionalProperties: false,
        description: "x402 on the host. Turning it off alone ({\"x402\": {\"enabled\": false}}) works without a license.",
        properties: {
          enabled: { type: "boolean" },
          priceCents: { type: ["integer", "null"], minimum: 1, maximum: 100000, description: "This host's price per request in US cents (paid in USDC); null for the x402 settings' price" },
        },
      },
    },
  },
  MonetizationHostX402: {
    type: "object",
    properties: {
      enabled: { type: "boolean" },
      priceCents: { type: ["integer", "null"], description: "This host's price per request in US cents; null for the x402 settings' price" },
    },
    required: ["enabled", "priceCents"],
  },
  MonetizationX402Settings: {
    type: "object",
    properties: {
      enabled: { type: "boolean" },
      configured: { type: "boolean", description: "On, with the CDP credentials, a Stripe deposit address and the live Stripe key it was created with: x402 can be offered" },
      priceCents: { type: "integer", description: "Price per request in US cents (paid in USDC); at least 1" },
      network: { type: "string", enum: ["eip155:8453"], description: "Base, the only network Stripe's x402 supports" },
      cdpKeyId: { type: ["string", "null"] },
      hasCdpKeySecret: { type: "boolean" },
      depositAddress: {
        type: ["object", "null"],
        description: "The Stripe crypto deposit address payments go to (Stripe custodies the funds). Cleared when the Stripe secret key is replaced or removed.",
        properties: {
          address: { type: "string" },
          livemode: { type: "boolean" },
          accountId: { type: ["string", "null"], description: "The Stripe account (GET /v1/account); null when the key may not read it (restricted keys)" },
        },
        required: ["address", "livemode", "accountId"],
      },
      stripeConfigured: { type: "boolean", description: "Stripe's secret key is set" },
      stripeMode: { type: ["string", "null"], enum: ["live", "test", null], description: "The Stripe key's mode; x402 needs a live key (it takes payments on Base mainnet)" },
      stripeReady: { type: "boolean", description: "The Stripe key set is live and the one the deposit address was created with" },
      notEnabledAt: { type: ["string", "null"], format: "date-time", description: "When Stripe last answered that Stablecoins and Crypto is not enabled; null once a call succeeds" },
      notEnabledMessage: { type: ["string", "null"] },
      networks: { type: "array", items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" } } } },
    },
    required: [
      "enabled", "configured", "priceCents", "network", "cdpKeyId", "hasCdpKeySecret", "depositAddress", "stripeConfigured", "stripeMode", "stripeReady",
      "notEnabledAt", "notEnabledMessage", "networks",
    ],
  },
  MonetizationX402SettingsInput: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      priceCents: { type: "integer", minimum: 1, maximum: 100000 },
      network: { type: "string", enum: ["eip155:8453"] },
      cdpKeyId: { type: ["string", "null"], description: "Coinbase Developer Platform API key id (the CDP facilitator)" },
      cdpKeySecret: { type: "string", writeOnly: true, description: "The CDP API key secret (stored encrypted)" },
    },
  },
  MonetizationX402Payment: {
    type: "object",
    properties: {
      id: { type: "integer" },
      proxyHostId: { type: "integer" },
      hostName: { type: ["string", "null"] },
      consumerId: { type: ["integer", "null"], description: "Set when a key holder paid with x402" },
      consumerName: { type: ["string", "null"] },
      payer: { type: "string" },
      network: { type: "string" },
      amountMicros: { type: "integer", description: "USDC micro-units (six decimals)" },
      amountCents: { type: "integer" },
      status: {
        type: "string",
        enum: ["verifying", "settling", "recording", "confirmed", "settled", "unrecorded", "unknown", "failed"],
        description: "recording: settled on chain, not recorded by Stripe yet (not answered); confirmed: recorded, not answered yet; settled: recorded and answered; unrecorded: Stripe refused to record it; unknown: the settlement's outcome never came back",
      },
      transaction: { type: ["string", "null"] },
      paymentIntentId: { type: ["string", "null"], description: "The Stripe PaymentIntent that records it" },
      errorReason: { type: ["string", "null"] },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    required: ["id", "proxyHostId", "hostName", "consumerId", "consumerName", "payer", "network", "amountMicros", "amountCents", "status", "transaction", "paymentIntentId", "errorReason", "createdAt", "updatedAt"],
  },
  MonetizationX402PaymentPage: {
    type: "object",
    properties: {
      payments: { type: "array", items: ref("MonetizationX402Payment") },
      total: { type: "integer" },
      page: { type: "integer" },
      perPage: { type: "integer" },
    },
    required: ["payments", "total", "page", "perPage"],
  },
  MonetizationStripeSettings: {
    type: "object",
    properties: {
      configured: { type: "boolean", description: "Both secrets are stored: consumers can top up" },
      hasSecretKey: { type: "boolean" },
      hasWebhookSecret: { type: "boolean" },
      mode: { type: ["string", "null"], enum: ["live", "test", null] },
      currency: { type: "string", description: "ISO 4217, lower case" },
      topUpAmountsMicros: { type: "array", items: { type: "integer" } },
      topUpUrl: { type: ["string", "null"], description: "Where 402 answers send consumers; null for the built-in portal page" },
      webhookUrl: { type: "string", description: "The endpoint to register in Stripe" },
      webhookEvents: { type: "array", items: { type: "string" }, description: "The events to send to it" },
      automaticTax: { type: "boolean", description: "Stripe Tax on Checkout Sessions (tax on top of the amount)" },
      x402TurnedOff: {
        type: "boolean",
        description: "Only in the answer to a save or removal that replaced or removed the secret key while x402 was set up: x402 was turned off and its deposit address cleared",
      },
    },
    required: [
      "configured", "hasSecretKey", "hasWebhookSecret", "mode", "currency", "topUpAmountsMicros", "topUpUrl", "webhookUrl", "webhookEvents",
      "automaticTax",
    ],
  },
  MonetizationStripeSettingsInput: {
    type: "object",
    additionalProperties: false,
    properties: {
      secretKey: { type: "string", writeOnly: true, description: "sk_live_…, sk_test_… or a restricted key rk_…" },
      webhookSecret: { type: "string", writeOnly: true, description: "The endpoint's signing secret, whsec_…" },
      currency: { type: "string", description: "Three-letter ISO 4217 code" },
      topUpAmountsMicros: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 10 },
      topUpUrl: { type: ["string", "null"], description: "https URL" },
      automaticTax: { type: "boolean", description: "Stripe Tax on Checkout Sessions; off-session postpaid charges carry no tax" },
    },
  },
  MonetizationLedgerEntry: {
    type: "object",
    properties: {
      id: { type: "integer" },
      consumerId: { type: "integer" },
      consumerName: { type: ["string", "null"], description: "null once the consumer is deleted" },
      type: { type: "string", enum: ["topup", "usage", "adjustment", "credit", "payment", "refund", "dispute"] },
      amountMicros: micros("Change of the balance"),
      balanceAfterMicros: micros("Balance after the entry"),
      requests: { type: "integer" },
      freeRequests: { type: "integer" },
      reference: { type: ["string", "null"] },
      description: { type: ["string", "null"] },
      createdBy: { type: ["integer", "null"] },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    required: [
      "id", "consumerId", "consumerName", "type", "amountMicros", "balanceAfterMicros", "requests", "freeRequests", "reference",
      "description", "createdBy", "createdAt", "updatedAt",
    ],
  },
  MonetizationMonthTotals: {
    type: "object",
    description: "Ledger totals of one calendar month (UTC).",
    properties: {
      month: { type: "string", format: "date", description: "The month's first day." },
      paidInMicros: { type: "integer", description: "Paid in through Stripe in the month: top-ups and postpaid payments." },
      topUps: { type: "integer" },
      payments: { type: "integer", description: "Postpaid payments." },
      refundedMicros: { type: "integer", description: "Refunded or disputed in the month." },
      chargedMicros: { type: "integer", description: "What metered requests cost the consumers, after failed-answer credits." },
      creditedMicros: { type: "integer", description: "Credited back for requests answered with a 5xx." },
      creditedRequests: { type: "integer" },
      requests: { type: "integer", description: "Every metered request, charged and free." },
      chargedRequests: { type: "integer" },
      freeRequests: { type: "integer", description: "Requests covered by the plans' free monthly requests." },
      adjustmentsMicros: { type: "integer", description: "Net of manual adjustments; negative when more was taken off than added." },
      adjustments: { type: "integer" },
    },
    required: [
      "month", "paidInMicros", "topUps", "payments", "refundedMicros", "chargedMicros", "creditedMicros", "creditedRequests", "requests",
      "chargedRequests", "freeRequests", "adjustmentsMicros", "adjustments",
    ],
  },
  MonetizationDay: {
    type: "object",
    properties: {
      day: { type: "string", format: "date" },
      requests: { type: "integer" },
      chargedRequests: { type: "integer" },
      freeRequests: { type: "integer" },
      chargedMicros: { type: "integer" },
      paidInMicros: { type: "integer" },
    },
    required: ["day", "requests", "chargedRequests", "freeRequests", "chargedMicros", "paidInMicros"],
  },
  MonetizationConsumerUsage: {
    type: "object",
    description: "One consumer's metered usage this month and the state of its keys.",
    properties: {
      consumerId: { type: "integer" },
      requests: { type: "integer" },
      chargedRequests: { type: "integer" },
      freeRequests: { type: "integer" },
      chargedMicros: { type: "integer" },
      keysLastUsedAt: { type: ["string", "null"], format: "date-time" },
      revokedKeys: { type: "integer" },
      lastRevokedAt: { type: ["string", "null"], format: "date-time" },
      funded: { type: "boolean", description: "The balance was ever topped up or raised by an adjustment." },
    },
    required: ["consumerId", "requests", "chargedRequests", "freeRequests", "chargedMicros", "keysLastUsedAt", "revokedKeys", "lastRevokedAt", "funded"],
  },
  MonetizationTopConsumer: {
    type: "object",
    properties: {
      consumerId: { type: "integer" },
      name: { type: ["string", "null"], description: "null for a deleted consumer" },
      planName: { type: ["string", "null"] },
      requests: { type: "integer" },
      chargedMicros: { type: "integer" },
      share: { type: "number", minimum: 0, maximum: 1, description: "Share of the month's metered requests." },
    },
    required: ["consumerId", "name", "planName", "requests", "chargedMicros", "share"],
  },
  MonetizationOverview: {
    type: "object",
    properties: {
      currency: { type: "string", description: "ISO 4217, lower case." },
      generatedAt: { type: "string", format: "date-time" },
      thisMonth: ref("MonetizationMonthTotals"),
      previousMonth: ref("MonetizationMonthTotals"),
      days: { type: "array", items: ref("MonetizationDay"), description: "The last 30 UTC days, oldest first." },
      topConsumers: { type: "array", items: ref("MonetizationTopConsumer"), maxItems: 5 },
      consumers: { type: "array", items: ref("MonetizationConsumerUsage") },
      balances: {
        type: "object",
        properties: {
          consumers: { type: "integer" },
          heldMicros: { type: "integer", description: "Sum of the positive balances." },
          heldFor: { type: "integer" },
          heldForDisabled: { type: "integer" },
          overdrawnMicros: { type: "integer", description: "Sum of prepaid consumers' negative balances, as a positive amount." },
          overdrawn: { type: "integer" },
          postpaidOpenMicros: { type: "integer", description: "Usage postpaid consumers have not paid yet." },
          postpaidOpen: { type: "integer" },
        },
        required: ["consumers", "heldMicros", "heldFor", "heldForDisabled", "overdrawnMicros", "overdrawn", "postpaidOpenMicros", "postpaidOpen"],
      },
      x402: {
        type: "object",
        description: "This month's x402 payments: recorded by Stripe, failed, and not recorded yet; what the recorded ones came to in US cents.",
        properties: {
          settled: { type: "integer" },
          failed: { type: "integer" },
          pending: { type: "integer" },
          amountCents: { type: "integer" },
        },
        required: ["settled", "failed", "pending", "amountCents"],
      },
      lastTopUp: {
        type: ["object", "null"],
        properties: {
          consumerId: { type: "integer" },
          consumerName: { type: ["string", "null"] },
          amountMicros: { type: "integer" },
          at: { type: "string", format: "date-time" },
        },
        required: ["consumerId", "consumerName", "amountMicros", "at"],
      },
    },
    required: ["currency", "generatedAt", "thisMonth", "previousMonth", "days", "topConsumers", "consumers", "balances", "lastTopUp", "x402"],
  },
  MonetizationLedgerPage: {
    type: "object",
    properties: {
      entries: { type: "array", items: ref("MonetizationLedgerEntry") },
      total: { type: "integer" },
      page: { type: "integer" },
      perPage: { type: "integer" },
    },
    required: ["entries", "total", "page", "perPage"],
  },
};
