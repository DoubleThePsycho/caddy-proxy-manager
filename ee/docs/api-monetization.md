# API monetization

Feature id `api_monetization` (Enterprise edition). Code: `ee/monetization/` (Elastic License 2.0); the Caddy wiring is in `src/lib/caddy.ts`.

If you sell access to an API that sits behind Ingressi, Ingressi can charge your API's consumers per request and enforce it at the edge: every request to a monetized host is checked before it reaches your API, and refused once it is not paid for. Consumers pay in one of three ways:

- **Prepaid**: they top up a balance through Stripe Checkout, and requests are refused once it is used up.
- **Postpaid**: they save a card through Stripe Checkout, usage is charged to it afterwards, and requests are refused once the unpaid usage reaches the plan's hard cap.
- **x402**: a client without an account pays a single request in USDC on Base, to a deposit address of your Stripe account (Stripe's machine payments).

Money moves only through **your own Stripe account**. Ingressi never holds money, keys or funds: it meters and enforces, Stripe moves the money to you (and, for x402, the CDP facilitator settles payments on chain to your Stripe deposit address).

Configure it on **API Monetization** in the dashboard (permission `monetization:read` to see it, `monetization:write` to change it) or through `/api/v1/monetization/*`.

## Money

Every amount is an integer number of **micro-units** of the install's currency: 1 USD = 1,000,000 micro-units, so a price of 0.0005 USD per request is `500`. API fields carry a `Micros` suffix; the dashboard shows and takes decimals. One currency per install, set with the Stripe settings (default `usd`). It cannot change while any consumer has a non-zero balance (`409`), since it is the unit of every balance and price.

Stripe amounts are in the currency's smallest unit; Ingressi converts by the currency's decimals (2 for most, 0 for JPY, KRW and Stripe's other zero-decimal currencies, 3 for BHD, JOD, KWD, OMR and TND). Top-up amounts must be whole smallest units.

x402 prices are whole US cents (`priceCents`): Stripe records USDC as US dollars, at least 0.01. x402 payments also show the amount in USDC micro-units (six decimals), so 0.01 USDC is `10000`.

## Setting it up

1. **Stripe** (API Monetization → Stripe):
   - **Secret key**: a secret key (`sk_live_…`, `sk_test_…`) or, better, a restricted key (`rk_…`). Its permissions: Checkout Sessions write (top-ups); for postpaid consumers also Customers write, PaymentIntents write, SetupIntents read and PaymentMethods write.
   - **Webhook**: in Stripe, Developers → Webhooks → Add endpoint, URL `<BASE_URL>/api/monetization/stripe/webhook` (shown on the Stripe tab and as `webhookUrl` in `GET /api/v1/monetization/stripe`), with these events (also listed as `webhookEvents`):
     - `checkout.session.completed` and `checkout.session.async_payment_succeeded`: top-ups, open amounts paid, cards saved;
     - `setup_intent.succeeded`: cards saved (postpaid);
     - `payment_intent.succeeded` and `payment_intent.payment_failed`: charges of saved cards (postpaid);
     - `charge.refunded` and `charge.dispute.created`: refunds and disputes.

     Paste the endpoint's signing secret (`whsec_…`). The URL must be reachable from the internet.
   - **Currency** and **top-up amounts** (up to 10) offered to prepaid consumers.
   - **Top-up URL** (optional): where `402` answers send consumers, for example your own developer portal. Default: `<BASE_URL>/api-portal`.
   - **Stripe Tax** (optional): Checkout Sessions (top-ups and open amounts) collect the payer's address and Stripe adds tax on top of the amount; the amount before tax is what is credited. Charges of saved cards carry no tax. Tax remains yours: Ingressi only passes the option to Stripe.

   Both secrets are stored encrypted (`encryptSecret`) and never returned (`hasSecretKey`, `hasWebhookSecret`). Use test keys first: the dashboard shows "Test mode".

   The webhook, the consumer portal (`/api-portal`) and the consumer API (`/api/monetization/*`) are served by the dashboard, and portal links, Checkout return URLs and the webhook URL are built from `BASE_URL`. So `BASE_URL` must be reachable by your consumers and by Stripe, at least for those paths (and `/_next/*` for the portal page's assets); the rest of the dashboard can stay behind your own access controls. The gate (`/api/monetization/gate`) only needs to be reachable from Caddy.
2. **Plans**: a price per request, optional free requests per calendar month (UTC), an optional per-minute limit, and:
   - **Billing**: prepaid (the default) or postpaid. A postpaid plan needs a **cap**, at most 10,000 units of the currency, and may set a **charge threshold** (default: half the cap).
   - **Don't charge for failed answers**: requests answered with a 5xx are credited back (see [Failed-answer credits](#failed-answer-credits)). Needs ClickHouse analytics.
   - **Accept x402**: key holders on the plan may pay a request with x402 when their balance does not cover it.
3. **Consumers**: a name, an optional e-mail (pre-filled on Checkout, and the e-mail of a postpaid consumer's Stripe Customer), a plan, optionally their own billing (prepaid or postpaid, overriding the plan's), and an **overdraft allowance** for prepaid consumers (default `0`, strictly prepaid). Create one or more **API keys** per consumer (shown once; up to 20 active) and, if you like, a **portal link** (shown once).
4. **Hosts**: turn monetization on for a proxy host, choose the header the key arrives in and, optionally, the plans allowed on the host (none checked: every plan). Optionally turn x402 on for the host with its price.
5. **Settings** (optional): how long usage history is kept, and whether sync replicas serve monetized hosts.

## The overview

API Monetization opens on **Overview**, computed from the ledger (and `GET /api/v1/monetization/overview`). Months and days are UTC, like the plans' free requests.

- **Paid in through Stripe**: the top-ups and postpaid payments credited this month and how many, what was refunded or disputed, and last month's total. This is what consumers paid, not what they have used.
- **Charged for requests**: what this month's metered requests cost, after failed-answer credits, split into charged and free requests, with last month's total.
- **Metered requests**: every request the gate let through this month, up to now, with last month's count.
- **Prepaid balances**: the sum of the positive balances (money paid in and not used yet), for how many consumers, and how many of them are disabled; balances below zero are shown apart: used through an overdraft allowance (prepaid), or owed by postpaid consumers.
- **Metered requests per day** (or **amount charged per day**) for the last 30 days, charged and free requests stacked, with the 1st of the month marked where free requests reset.
- **Top consumers** of the month by metered requests, with their plan, what they were charged and their share of the month's requests.
- **x402 payments** of the month: how many were recorded by Stripe and their amount, and how many failed or are not recorded yet (shown once there are any).
- The consumers with this month's requests, free requests used, charge, balance (including usage not yet written to the ledger), limit (overdraft allowance, or the postpaid cap) and when their keys were last used, with a postpaid consumer's card and state; the plans; the monetized hosts; and the Stripe settings with the last top-up.

The ledger is written every few seconds, so the overview can trail the gate by that much. Amounts are summed as integer micro-units and never rounded.

## Calling a monetized API

Consumers send their key as `Authorization: Bearer ik_…` (the default) or in the header you chose for the host, for example `X-API-Key: ik_…`.

| Status | When | Body / headers |
| --- | --- | --- |
| upstream's answer | Key valid, consumer active, plan allowed, within the per-minute limit, and a free request left or the balance (prepaid) or the cap (postpaid) covers the price; or a valid x402 payment | Forwarded with `X-Ingressi-Consumer-Id` (consumer id) and `X-Ingressi-Plan` (plan id) when a consumer is known. An x402 payment (settled and recorded by Stripe first) adds `PAYMENT-RESPONSE` to the answer. |
| `401` | No key, or a malformed, unknown or revoked key | `{"error": "missing_api_key" \| "invalid_api_key", "message"}`, `WWW-Authenticate: Bearer realm="api"` for Authorization. On a host with x402, a request without a key gets the `402` with x402 below instead. |
| `402` `payment_required` | Prepaid: the balance minus the price would go below minus the overdraft allowance | `{"error": "payment_required", "message", "balance": "0.002", "price": "0.004", "balanceMicros": 2000, "priceMicros": 4000, "currency": "USD", "topUpUrl"}` and `Link: <topUpUrl>; rel="payment"`. |
| `402` `usage_cap_reached` | Postpaid: the unpaid usage would pass the plan's cap | `{"error", "message", "openAmount", "cap", "price", "openAmountMicros", "capMicros", "priceMicros", "currency", "paymentUrl"}` and the `Link` header. |
| `402` `payment_method_required` | Postpaid without a usable saved card (none saved, or expired) | `{"error", "message", "paymentUrl"}` and the `Link` header. |
| `402` `payment_overdue` | Postpaid and suspended: a charge failed, the bank asked to confirm a charge, or a payment is disputed | `{"error", "message", "reason": "payment_failed" \| "authentication_required" \| "dispute", "paymentUrl"}` and the `Link` header. |
| `402` with x402 | A host with x402: a request without a key, or a key holder whose plan accepts x402 and who got one of the 402s above | The JSON body (the 402 above, or `{"error": "payment_required", "message", "topUpUrl"}`) plus `"x402"` with the offer, and `PAYMENT-REQUIRED` (see [x402](#x402-pay-per-request)). |
| `403` | Consumer disabled, consumer without a plan, plan not allowed on the host | `{"error": "consumer_disabled" \| "no_plan" \| "plan_not_allowed", "message"}` |
| `429` | Per-minute limit reached (or an x402 payer's) | `{"error": "rate_limited", "message", "limit", "retryAfter"}` and `Retry-After` (seconds to the next minute). |
| `503` | Redis or Valkey ([shared state](high-availability.md#shared-state-phase-3)), or on a replica the master's gate, cannot be reached; the x402 facilitator or Stripe cannot be reached, or a settled x402 payment is not recorded by Stripe yet. The request is refused, never let through unpaid. | `{"error": "unavailable" \| "x402_unavailable", "message"}` and `Retry-After`. |

Free monthly requests are used before the balance. Refused requests are not charged. Requests answered by a redirect or a path block of the host are not charged either (they are answered before the gate); the WAF and geoblocking run before it.

Example 402:

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json
Link: <https://dash.example.com/api-portal>; rel="payment"

{"error":"payment_required","message":"The prepaid balance does not cover this request; top up to continue","balance":"0","price":"0.001","balanceMicros":0,"priceMicros":1000,"currency":"USD","topUpUrl":"https://dash.example.com/api-portal"}
```

Your API receives `X-Ingressi-Consumer-Id` and `X-Ingressi-Plan` only from the gate: copies sent by clients are removed on every route of the host (all `-`/`_` spellings, and the whole `X-Ingressi-Consumer-*` family). The consumer's key header is passed on unchanged; x402 payment headers (`PAYMENT-SIGNATURE`, `X-PAYMENT`) are not.

## How consumers pay

- **Portal link** (`<BASE_URL>/api-portal/<token>`): a page with the balance (or, postpaid, the unpaid usage, the cap, when the next charge runs and the saved card's brand and last four digits), the plan, free requests left, recent activity and the payment buttons. No account needed; the token is per consumer, stored as a SHA-256 hash and replaced with **Issue a new link** (the old one stops working) or turned off. Anyone with the link can see that page and pay, so send it only to the consumer.
- **Key-based portal** (`<BASE_URL>/api-portal`, the default link of `402` answers): the consumer pastes one of their API keys to see the same page.
- **Consumer API**, authenticated with the consumer's own key (`Authorization: Bearer` or `X-API-Key`), not billed:
  - `GET /api/monetization/me`: consumer, plan, `balanceMicros`, `overdraftAllowanceMicros`, free requests used and left, the top-up amounts, `billing`, `postpaid` (open amount, cap, threshold, next charge, card, state) and the 20 most recent ledger entries.
  - `POST /api/monetization/me/checkout` with `{"amountMicros": 10000000}`: `{"url"}` of a top-up Checkout Session (prepaid).
  - `POST /api/monetization/me/card`: `{"url"}` of a Checkout Session that saves a card (postpaid).
  - `POST /api/monetization/me/pay`: `{"url"}` of a Checkout Session paying the open amount (postpaid).

  The portal link's page uses `POST /api/monetization/portal/{checkout,card,pay}` with `{"token", …}` the same way.

### Prepaid top-ups

A top-up creates a Stripe Checkout Session in payment mode for the chosen amount, with `metadata.ingressi_consumer_id` and `metadata.ingressi_install` (this install's id, so a Stripe account shared by several installs only credits its own sessions), and success/cancel URLs back to the portal. When Stripe's webhook reports the session paid (`checkout.session.completed` with `payment_status: paid`, or `checkout.session.async_payment_succeeded` for delayed methods such as SEPA debit), the balance is credited and the gate sees it at once. The ledger reference `stripe:<session id>` makes this idempotent: Stripe retrying or sending both events credits once. Each consumer can start at most 10 checkouts per 10 minutes (and 10 card or open-amount sessions each); `GET /me` is limited to 60 calls a minute per consumer (for the whole cluster with high availability shared state, per web node otherwise).

### Postpaid

A postpaid consumer uses the API first and pays afterwards, never more than its plan's **cap** in unpaid usage.

- **Card.** The consumer saves a card from the portal: Stripe Checkout in setup mode, for a Stripe Customer in your account that carries `metadata.ingressi_install` and `metadata.ingressi_consumer_id`. Ingressi keeps the PaymentMethod id and the card's brand, last four digits and expiry, nothing else. Without a saved card, or once it has expired, requests get `402 payment_method_required`.
- **Cap.** The gate admits a request while the unpaid usage after it stays within the cap. That holds whatever happens to charges: a charge sent but not answered yet counts as unpaid until it succeeds.
- **Charges.** The leader charges the saved card off-session for the open amount (rounded down to the smallest unit, so a card is never charged more than was used): when it reaches the plan's threshold, at the end of every billing period (the 1st of the month, UTC, once per period), and in the last three days before the card expires. Amounts below Stripe's minimum charge (0.50 USD or EUR, say) stay open for the next one. Each charge is written down (`monetization_payments`, "pending", with its Stripe idempotency key) before Stripe is called, and its PaymentIntent carries `metadata.ingressi_charge_id`. It is credited (ledger type `payment`, reference `stripe-pi:<PaymentIntent>`) from Stripe's answer or from `payment_intent.succeeded`, whichever comes first, once.
- **A lost answer.** If Ingressi stops, or Stripe does not answer, between sending a charge and recording it, the charge stays pending and counts as on its way, so the same usage is never charged twice. Within Stripe's 24 hours the leader sends it again with the same idempotency key (Stripe answers with the first outcome and charges once); after that it looks the charge up by its metadata. This runs at start and every five minutes.
- **Failure.** A declined charge, or one the bank wants the card holder to confirm (`authentication_required`), suspends the consumer: `402 payment_overdue`, with a link to the portal, where the open amount is paid in Checkout (which also saves the card used for later charges). The payment credits the balance and ends the suspension. No automatic charge is tried while a consumer is suspended. **Charge open amount now** (`POST /api/v1/monetization/consumers/{id}/billing/charge`) charges at once.
- **Your key refused.** When Stripe answers `401` or `403` (the secret key was revoked, expired, or lacks a permission), the problem is yours, not the card's: the charge stays pending (still counted as on its way, so the cap holds), nobody is suspended, an audit event (`stripe_key_rejected`) and an item on the overview's **Needs attention** say so, and the charge is sent again with the same idempotency key once the key works (the reconciliation every five minutes, or after you save a new key).
- **Switching a consumer** between prepaid and postpaid (its billing, or its plan) runs under the consumer's charge lock, so no charge, refund or other switch of it runs meanwhile. Leaving postpaid first suspends the consumer for the few seconds the switch takes (`402 payment_overdue` with `"reason": "billing_switch"` and `Retry-After: 5`), so nothing more is admitted under the old cap; then the open amount (usage not written yet included) is charged to the saved card, the balance read again and any residue (requests another node admitted before the suspension reached it) charged too, and only then the new billing written and the suspension lifted. The switch is refused (`409`) unless the charges go through, while a charge is on its way, and while the consumer is suspended for another reason. An open amount below Stripe's minimum charge cannot be charged and stays as a small negative balance, which the now prepaid consumer tops up before it is admitted past its overdraft again. A switch that stops half way (a crash) leaves the suspension, which the leader lifts within about three minutes. Entering postpaid turns a negative prepaid balance into the open amount, charged like any other. A positive balance is kept as credit either way. **Switching a plan's billing** settles first: refused while a consumer on it without billing of its own owes anything or has a charge on its way. While replicas gate with this master's shared state (Settings), billing cannot switch at all (`409`): they would keep the old billing and cap until their next sync. Replicas served with allowances follow at once, since the master charges for them.
- **Receipts** are Stripe's, as set in your Stripe account (Settings → Customer emails). Ingressi issues no invoices.

### Refunds and disputes

Refunds and disputes made in Stripe are written to the ledger and come off the balance, so a balance stays "paid in minus used": `charge.refunded` takes off what was refunded since the last event (reference `stripe-refund:<charge>:<total refunded>`, once per total), `charge.dispute.created` takes off the disputed amount (reference `stripe-dispute:<dispute>`) and suspends a postpaid consumer until an administrator resumes it (**Resume**, `POST /api/v1/monetization/consumers/{id}/billing/resume`, needs the license). Two refunds of one payment arriving together take off the larger total once, not the sum (they run one after the other under the consumer's charge lock). A refund or dispute can arrive before the event of its payment (Stripe does not order events), or be for a top-up paid before this release: its Checkout Session is then looked up in Stripe by the PaymentIntent (`GET /v1/checkout/sessions`, which a restricted key's **Checkout Sessions** permission covers) and applied first, exactly as its own event would be, so it is still credited once. If Stripe cannot be asked, the webhook answers `503` and Stripe sends the event again. A refund you meant as goodwill on a postpaid charge brings the amount back as owed: add a positive balance adjustment to forgive it.

### Webhooks

The webhook verifies `Stripe-Signature` on the raw body as Stripe documents for manual verification (HMAC-SHA256 of `<t>.<body>` with the signing secret, any `v1` signature, timestamp within 5 minutes) and answers `400` otherwise, `503` while no signing secret is configured. Every event is idempotent: replayed, retried or delivered twice (a session and its PaymentIntent), it changes nothing more. Sessions in another currency, of another install, unpaid or for deleted consumers, and PaymentIntents Ingressi did not create, are acknowledged and ignored.

## Failed-answer credits

On plans with **Don't charge for failed answers**, a request whose answer was a 5xx (your API's own 5xx, or Caddy's 502, 503 or 504 when your API could not answer) is credited back. The request is still admitted against the balance or cap when it arrives (the gate does not wait for the answer); the credit follows within about a minute.

- For each request it lets through on such a plan, the gate answers with a **charge id** (`c1.<consumer>.<charged>.<free>.<time>.<random>.<mac>`, signed with a key derived from the gate token, so only the gate can issue one), which Caddy writes into the request's access log line (`ingressi_charge`) next to the status the client got.
- The access-log pipeline (the log parser, every 30 seconds) credits every line with a charge id and a 5xx: the charged amount back on the balance, and a free request of the current month given back. Credits of a consumer and hour share one ledger row of type `credit` (reference `answer-credit:<consumer>:<hour>`).
- **Once per charge id**: without shared state the ids credited are written in the same transaction as the credit (`monetization_answer_credits`); with shared state one atomic script remembers each id. A log line read twice (a restart before the parser stored its position, a rotated log) credits once. Ids older than 7 days, forged, or of another install are ignored; credits that could not be written are retried with the next pass.
- It needs **ClickHouse analytics** (`CLICKHOUSE_PASSWORD`): the option cannot be turned on without it (`409`), and the gate issues no charge ids while it is not configured.

A 5xx is credited even when your API did the work before failing; leave the option off for APIs where that matters. A consumer who can make your upstream fail on purpose (a request that crashes it, a timeout it can provoke) gets those requests free: turn the option on only for upstreams whose 5xx are their own fault, not the caller's.

## x402 pay-per-request

[x402](https://github.com/x402-foundation/x402) lets a client pay a single HTTP request with a stablecoin, without an account. Ingressi takes x402 payments through **Stripe's machine payments** ([Stripe: x402 payments](https://docs.stripe.com/payments/machine/x402)): clients pay USDC on Base to a crypto deposit address of your Stripe account, and every payment is recorded as a PaymentIntent in your Stripe balance before the request is answered. The protocol side uses the official x402 SDK (`@x402/core` and `@x402/evm` 2.28.0): x402 version 2, the `exact` scheme with EIP-3009 `transferWithAuthorization`. Payments are verified and settled on chain by the **Coinbase Developer Platform (CDP) facilitator**, through `@coinbase/x402` 2.1.0. Version 1 clients (`X-PAYMENT`) are asked for version 2.

### Availability

Stripe's machine payments are a preview (API version `2026-05-27.preview`, which Ingressi sends on these calls) and need the **Stablecoins and Crypto** payment method, which Stripe turns on for an account after a review: request it in the Stripe Dashboard under Settings, Payment methods. Outside the US, the account owner emails machine-payments@stripe.com with the Stripe account ID to request access. Until then Stripe refuses to create the deposit address or to record payments, and the x402 tab says so. Stripe documents no error code for this refusal: Ingressi takes `payment_method_unactivated` or `payment_method_not_available`, or a refusal whose message says crypto or stablecoins are not activated, enabled or available, as meaning it. Stripe's smallest payment is 0.01 USDC, so prices are whole US cents.

### Setting it up

1. **Stripe tab**: a **live** secret key (`sk_live_…` or `rk_live_…`): x402 takes real payments in USDC on Base mainnet, so a test key cannot turn it on (`409`). The deposit address is created, and payments recorded, with this key. A restricted key needs write access to PaymentIntents and to crypto deposit addresses; Stripe's documentation does not name a restricted-key permission for deposit addresses yet, so if Stripe refuses a restricted key there, use a standard secret key. **Replacing the secret key with another one, or removing it, turns x402 off and clears the deposit address** (it belongs to the old key's account and mode: payments to it could not be recorded with another account's key). The answer says so (`x402TurnedOff`), the Stripe tab warns, and an audit event records it; turn x402 on again to create an address with the new key. Saving the Stripe settings without a new key changes nothing for x402.
2. **x402 tab** (permission `monetization:payments`, since these settings decide where payments go):
   - **Price per request** in US dollars, whole cents, at least 0.01 (`priceCents`, default 1). A host can set its own.
   - **Network**: Base (`eip155:8453`), the only network Stripe's x402 takes; the token is USDC (`0x8335…2913`, six decimals).
   - **CDP API key id and secret**, from the Coinbase Developer Platform portal. Every facilitator call (`https://api.cdp.coinbase.com/platform/v2/x402`: `GET /supported`, `POST /verify`, `POST /settle`) carries a short-lived JWT signed with the key by `@coinbase/x402` (Ed25519 for a base64 secret, ES256 for an EC key in PEM). The secret is checked when you save (it must be able to sign: nothing is sent), stored encrypted and never returned.
   - **Accept x402 payments**: turning it on creates the **deposit address** in your Stripe account (`POST /v1/crypto/deposit_addresses` with `network=base`), once, and keeps it, with the Stripe account it belongs to (`GET /v1/account`; restricted keys may not read it, and the account is then not shown) and a digest of the key that created it. x402 is offered only while that same live key is set; the tab shows the address, its mode and the account. Turning x402 off (`DELETE /x402`) removes the CDP secret and keeps the address.
3. **Hosts tab**, per host: turn x402 on, optionally with its own price (`priceCents`).
4. Plans with **Accept x402** let their key holders pay with x402 when their balance (or cap) does not cover a request; they pay the x402 price, the host's or the settings'.

### How a request is paid

1. A request without a key gets `402` with your JSON body, `"x402"` with the offer, and `PAYMENT-REQUIRED`, which the SDK builds: the base64 of `{"x402Version": 2, "resource": {"url"}, "accepts": [{"scheme": "exact", "network": "eip155:8453", "amount": "10000", "asset": "0x8335…2913", "payTo": "<the deposit address>", "maxTimeoutSeconds": 120, "extra": {"name": "USD Coin", "version": "2"}}]}` for $0.01. `Access-Control-Expose-Headers` lists `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE`. Each web process asks the facilitator for its capabilities (`GET /supported`) once; while it cannot be reached (asked again every 30 seconds), or does not take `exact` payments on Base, nothing is offered: requests get the plain `401` or `402`, and a request that carries a payment `503`.
2. The client retries with `PAYMENT-SIGNATURE`. Every attempt counts against the client's address (120 a minute, an IPv6 /48 as one address). The address is the one Caddy determined (the connection's, or the one your trusted proxies report) and sets on the gate's subrequest (`X-Ingressi-Client-Ip`, replacing any copy the client sent): never a header the client controls. An address with 10 payments refused by the facilitator within a minute is refused (`429`) for the rest of it, before another facilitator call. Each web process sends the facilitator at most 200 verifications a second, one address at most 20 of them (past that, `503` with `Retry-After: 1`), and takes at most 60 paid requests per payer and minute (`429`), counted once the facilitator has verified the payment: a payer address that is only claimed (anyone can write another's address in a payload) never uses up that payer's limit.
3. A payload whose nonce was already claimed is answered from its payment, at the amount it was paid at, even after a price change, with x402 or the host's x402 turned off, or while the facilitator is unreachable (see the states below); it is never checked against the current offer. The SDK matches a new payload against this request's offer (`findMatchingRequirements`): scheme, network, token, amount, receiving address, payment window and token domain must be exactly as offered, or the answer is `402` with `invalid_payment_requirements`, before anything is stored or asked. A payload that names another resource gets `invalid_resource`; one that is not an x402 version 2 `exact` EVM payload, `invalid_payload`.
4. **Replay protection**: the authorization's nonce (with network, token and payer) is claimed in the database, unique across every web node, before the facilitator is asked: a payment payload is accepted once. One the facilitator refuses, or could not verify, is released and leaves no row, so the client may send it again.
5. The CDP facilitator **verifies** the payment (signature, balance, amount, receiving address, window) and then **settles** it on chain, always before the request is forwarded. A verification that names another payer than the authorization's is refused (`payer_mismatch`). A settlement for another network or payer than the one verified is not accepted (kept as `unknown`, `settlement_mismatch`), and one transaction backs one payment: the database has unique indexes on the transaction (with its network) and on the PaymentIntent, and a second payment claiming either is `unrecorded` (`duplicate_transaction`, `duplicate_payment_intent`).
6. The settled transaction is **recorded with Stripe**: `POST /v1/payment_intents` with the amount in cents, `currency=usd`, `confirm=true`, `payment_method_data[type]=crypto`, `allowed_payment_method_types[]=crypto`, `payment_method_options[crypto][mode]=transaction_verification`, `…[transaction_verification_options][network]=base` and `…[transaction_hash]=<the transaction>`, with the transaction hash as idempotency key (as Stripe's guide does), and the live key the deposit address was created with. Stripe checks the transaction on chain against its deposit address and the amount. Only when the PaymentIntent's status is `succeeded` is the request forwarded, with `PAYMENT-RESPONSE` (base64 `{"success": true, "transaction", "network", "payer"}`).

A request is never forwarded on a payment that is not both settled and recorded by Stripe. What happens otherwise:

| Payment state | When | The client gets |
|---|---|---|
| `failed` | The facilitator settled nothing (insufficient funds, an expired authorization) | `402` with the reason, and `PAYMENT-RESPONSE` saying why |
| `recording` | Settled on chain; Stripe could not be reached, answered `5xx` or `429`, is still checking the transaction, has not enabled Stablecoins and Crypto, or refused it fewer than three times; or the Stripe key was replaced or removed since (`stripe_key_changed`: recorded once a live key set up for x402 is set) | `503` with `Retry-After: 10`: send the same payment again; it is not taken twice. The retry records it with the same idempotency key and is answered once Stripe confirms. The leader's reconciliation (every minute, for payments waiting at least 30 seconds) records it too. After a refusal, the next attempt waits a minute, the one after ten minutes, each with a new idempotency key (`<hash>:2`, `<hash>:3`) so that Stripe does not replay the refusal |
| `confirmed` | Stripe confirmed it (by the reconciliation) before the request was answered | The same payload sent again is forwarded, once |
| `settled` | Recorded and answered | The same payload again: `402 payment_already_used` |
| `unrecorded` | Stripe refused to record it three times (the transaction did not verify, or the PaymentIntent did not succeed), or its transaction or PaymentIntent already backs another payment | `409 payment_not_recorded`: contact the API's operator. Never forwarded |
| `unknown` | The settlement's outcome never came back (the facilitator unreachable or timing out while settling, a transaction still `settlement_pending` after the SDK's one retry, a crash while settling, or a settlement for another network or payer) | `503`, then `409 payment_not_recorded` for the same payload. Never settled again or forwarded |

Payments in `recording`, `unrecorded` and `unknown` show on **Needs attention** ("x402 payments not recorded by Stripe") with their transaction, for you to check against your Stripe balance and the chain. A nonce claimed but never verified (a crash) is released after 2 minutes. Each facilitator call and each Stripe call times out after 15 seconds. Anything that cannot be checked fails closed: no answer from the facilitator or Stripe never lets a request through.

The payment payload never reaches your API (the headers are removed) and is never logged by Ingressi: Caddy's access log drops `Payment-Signature` and `X-Payment`, and Ingressi stores only the payer's address, the amount, the transaction hash and the PaymentIntent id. Two logs Ingressi does not filter can still show it: Caddy's own error log (its default log, to the container's standard error), which can include a failed request's headers, and the WAF's audit log, which records the request headers of requests a WAF rule matched. A payload there pays your deposit address only, for one request, until its window closes; keep those logs as private as your access log.

### Why three attempts

Stripe documents no error codes for `transaction_verification` PaymentIntents: neither its x402 guide nor its public API reference (which does not list the preview parameters) says how it answers a transaction it has not indexed or confirmed yet, and its own sample sends one request with the transaction hash as idempotency key. Since Stripe keeps an idempotency key's answer for 24 hours, a refusal of a transaction it had not seen yet would otherwise be final. Ingressi therefore asks again after any refusal, twice, a minute and ten minutes later, with new idempotency keys; the unique indexes keep one transaction to one payment whatever Stripe answers.

### The Coinbase SDK's telemetry

`@coinbase/x402` loads `@coinbase/cdp-sdk` only for its `auth` module, which signs the facilitator's JWTs and makes no network call (checked for 1.57.1: the module and everything it loads use no `fetch` and send nothing; the SDK's analytics module is not loaded). Elsewhere in the SDK (its CDP client), usage events, and error reports with their message and stack, are sent to `https://cca-lite.coinbase.com/amp` unless `DISABLE_CDP_USAGE_TRACKING=true` and `DISABLE_CDP_ERROR_REPORTING=true`. Ingressi sets both to `true` before it loads the SDK (a value you set yourself is kept), and the Docker image sets them too; if you run Ingressi outside the image and want to be explicit, set them in its environment.

### Metering

x402 payments are not charged to balances. They are recorded with the payer's address, the network, the amount (USDC micro-units, and cents), the transaction hash, the Stripe PaymentIntent and the state: on the x402 tab, under the ledger, in the overview (the month's recorded payments and their amount, and how many failed or are not recorded yet), and in `GET /api/v1/monetization/x402/payments`. A key holder who paid with x402 is named; anyone else needs no account. A paid request writes a few rows to the database; the gate's key-based path still needs none.

### Your responsibilities

Stripe custodies and settles the funds: payments go to a deposit address of your Stripe account, Stripe credits them to your Stripe balance and pays them out under your Stripe agreement. Ingressi holds no funds, keys or wallets and signs no transactions. Receiving stablecoin payments can bring obligations (for example tax and anti-money-laundering rules) that are yours to check.

### Sources

- Stripe: [x402 payments](https://docs.stripe.com/payments/machine/x402) (the deposit address, the `transaction_verification` PaymentIntent, the preview API version), [machine payments](https://docs.stripe.com/payments/machine) (availability and the review), [create a crypto deposit address](https://docs.stripe.com/api/crypto/deposit-address) (the API reference), and the [machine payments samples](https://github.com/stripe-samples/machine-payments) (`x402/server/node-typescript`). The sample sends `payment_method_types[]=crypto`; Ingressi follows the guide's `allowed_payment_method_types[]=crypto`.
- x402: the [specification and SDK](https://github.com/x402-foundation/x402) (`@x402/core` `x402ResourceServer` and `HTTPFacilitatorClient`, `@x402/evm` `ExactEvmScheme`), and [`@coinbase/x402`](https://www.npmjs.com/package/@coinbase/x402) (`createFacilitatorConfig`: the CDP facilitator's URL and its JWT authentication).

## Sync replicas and pull replicas

By default monetized hosts stay out of the instance sync payload, so slaves and fleet pull replicas never serve them (and never serve them ungated). On **Settings → Sync replicas** the master can let replicas serve them, but only gated with the master's balances:

Changing this needs `instances:write` as well as `monetization:write`: it decides what the master sends its replicas, and where they send their allowance credential.

- **Through shared state**: the master uses [high availability shared state](high-availability.md#shared-state-phase-3), and its replicas reach the same Redis or Valkey with the certificate storage settings they receive. They charge the master's balances with the same atomic scripts as the master's own nodes. A replica never creates a consumer's balance (it has none): the master's leader writes every consumer's balance there once a minute, and until then the replica refuses (`503`). **A replica in shared mode is trusted like the master**: it holds the master's Redis or Valkey credentials, so whoever controls it can change any balance there. Use shared mode only for nodes you run and trust as you trust the master; use allowances for anything else.
- **With allowances from the master's gate**: a replica asks the master for an allowance (up to 50 requests, valid 30 seconds): a pull replica at the master URL it polls, a pushed slave at the **gate URL** you set (default `BASE_URL`). The gate URL must be `https`, set or by default (`http` only with `INSTANCE_SYNC_ALLOW_HTTP=true`, the rule of the sync itself, on the master and on the replica); otherwise the Settings tab says why and replicas do not serve monetized hosts. The replica authenticates with an **allowance credential** derived from its sync secret (HMAC-SHA256, labelled `ingressi:monetization-allowance:v1`, of a pushed slave's sync token or of a pull replica's fingerprint token), which the master recomputes per replica: it opens only the allowance endpoint, so whoever reads it cannot push configuration to the slave nor fetch the master's, and the sync token itself is never sent to the gate URL. The endpoint counts failed authentications per client address (30 a minute) before it looks at any credential, and finds the replica through an index of credential digests. The replica forwards the **API key the client presented**, and the master checks it as its own gate would (constant time): a replica can only reserve requests for keys it was actually sent, never charge a consumer by naming it. The master grants allowances only while it serves replicas with allowances, only for hosts that replica was sent (a replica in a promotion-only fleet environment: the hosts of its environment's revisions), and holds allowances not reported yet within caps per node of the replica (each process of it names itself): 4 per consumer and 20,000 in all on each node, at most 16 node names per replica at once. A replica run on several nodes therefore gets a share per node, and what one replica, compromised or not, can have reserved for one consumer without reporting it is bounded per window: at most 16 × 4 allowances of at most 50 requests, 3,200 requests, within the master's memory of its allowances (about five and a half minutes), each also within the consumer's balance or cap and its plan's per-minute limit. It is a rate, not a total: allowances the master has forgotten free their places, so a replica that never reports can reserve that many again every window. No total is set, since whoever holds the consumer's key (as a replica that serves it does) can spend its balance as fast through the public gate. It **charges the allowance before granting it**, exactly as that many requests at its own gate (free requests first, then the price, within the overdraft allowance or the cap, and within the per-minute limit). The replica admits at most what it was granted, until the allowance expires, and reports what it used with its next request; the master gives back the rest, once per allowance, only to the replica it granted it to (a report that arrives after the month changed gives back the money, never the month's free requests). So every request a replica admits was paid for on the master first, and the unpaid exposure stays within the same limit however many replicas run (a test drives three replicas and the master against one balance and checks it). An allowance whose report never comes stays charged: a consumer pays at most 50 requests it did not make per allowance, never the other way round.

With either mode the master sends the gate's index with the configuration: plans, consumers with their status and billing state (no balances), API keys as SHA-256 digests (sealed to the replica's sync key in transit and stored encrypted there), the monetized hosts and their proxy hosts. Replicas from earlier releases ignore it and keep not serving those hosts. Changes reach replicas with the next sync, which a change to the index starts within seconds (pull replicas fetch it with their next poll). A consumer disabled or a key revoked on the master is refused by a replica at once in shared mode; with allowances, when the replica's allowance runs out (at most 30 seconds) or with the next sync. Replicas do not offer x402; with allowances they do not credit failed answers.

When the chosen mode cannot be used (shared mode while the master has no shared state, allowances without an https gate URL), the Settings tab says why and replicas keep not serving monetized hosts. A slave cannot turn monetization on itself (`409`).

## Usage history

Hourly usage and failed-answer credit rows older than the retention (Settings → Usage history, default 13 months, 1 to 120) are deleted once a day by the leader, in batches. Top-ups, payments, refunds, disputes and adjustments are kept: they record money moved. Balances never change: they are kept on the consumers, not summed from the ledger. The setting is the master's (the ledger is); it does not go to replicas.

## How it works

For a monetized host, the generated Caddy configuration adds two handlers to every route of the host:

1. a `headers` handler removing client copies of `X-Ingressi-Consumer-Id`, `X-Ingressi-Plan` and `X-Ingressi-Consumer-*`;
2. a forward-auth-style `reverse_proxy` subrequest (`GET /api/monetization/gate`, same dial address as the built-in forward auth) carrying `X-Ingressi-Gate-Token`, `X-Ingressi-Host-Id` and the request's path (`X-Forwarded-Uri`). A `2xx` answer copies the two gate headers onto the request, logs the charge id (failed-answer credits), copies `PAYMENT-RESPONSE` onto the answer and removes x402 payment headers, then continues to your upstream; any other answer is returned to the client as the gate wrote it.

The **gate token** is 32 random bytes generated once per install and stored encrypted (settings key `monetization_gate`); only the generated Caddy configuration carries it. The gate compares it in constant time (SHA-256 digests) and answers a bare `403 {"error":"forbidden"}` without it, so the gate cannot be called directly. If the dashboard cannot be reached, Caddy answers `502`: requests fail closed.

The gate decides **without a database query** for API keys. It keeps an in-memory index (key prefix → key hash and consumer, consumers with their billing state, plans, monetized hosts with their x402 settings) loaded at start and reloaded whenever an administrator changes something; top-ups, payments and suspensions refresh the consumer at once. Usage is counted in memory and **written to the database every 5 seconds** and when the process is stopped (SIGTERM or SIGINT), in one transaction: the balance (a relative update, so top-ups written meanwhile are kept), the free requests used this month, the keys' last use, and one `usage` ledger entry per consumer and UTC hour that is updated in place.

**With several web nodes** ([high availability shared state](high-availability.md#shared-state-phase-3), Enterprise), balances, free requests and per-minute windows live in Redis or Valkey instead: each gate call runs one atomic script there (one more round trip on the internal network), so requests on several nodes never spend the same money twice. Top-ups, payments and adjustments credit the shared balance at once. The leader writes usage and credits back to the ledger every 5 seconds, idempotently; the ledger and the overview trail the gate by that much. Disabling a consumer or revoking a key is refused by every node at once; other changes reach the other nodes within seconds.

**Cost of one gate call:** one extra HTTP round trip from Caddy to the dashboard process on the internal network (Caddy keeps the connection alive), Next.js routing (the middleware returns at once for this path), two SHA-256 digests of short strings (gate token and API key), a constant-time comparison of each, a handful of `Map` lookups and integer arithmetic, and on plans with failed-answer credits one HMAC. No I/O beyond the HTTP exchange. Expect well under a millisecond of work in the dashboard per request on top of the hop; throughput is bounded by the single Node.js/Bun process of the dashboard. x402 payments add the facilitator's round trips and a few database writes per paid request.

## Money safety

How the unpaid exposure stays bounded:

- **Prepaid**: a request is admitted only while the balance after it stays above minus the overdraft allowance. Usage counted but not yet written is subtracted first.
- **Postpaid**: the same rule with the plan's cap. A charge on its way is not counted as paid, so a lost, slow, failed or key-refused charge never lets the unpaid usage pass the cap. A failed charge suspends the consumer; a dispute takes the amount off and suspends; a key Stripe refuses suspends nobody. Charges are sent once (Stripe idempotency keys, recorded before the call) and credited once (ledger references), whichever of the API answer, the webhook and the reconciliation comes first. Refunds and disputes of a consumer run under its charge lock, as do billing switches.
- **Several web nodes**: one atomic script per request in shared state, so nodes never spend the same money twice. Without shared state, several replicas on one database are refused (`409`).
- **Replicas**: through shared state, the same atomic scripts (and the replica is trusted like the master); with allowances, every request admitted was charged on the master first, for a key the replica was actually presented, with at most 4 allowances unreported per replica and consumer.
- **Failed-answer credits** only give money back, once per charge id, for ids only the gate can issue.
- **x402**: the payload must match the offer exactly (the SDK), is verified and settled by the facilitator, and recorded by Stripe as a PaymentIntent that succeeded, all before forwarding. A payload is accepted once (its nonce, unique in the database), and forwarded once; a settled payment Stripe has not recorded is never forwarded, and is recorded later with the same idempotency key.
- **Failures fail closed**: an unreachable Redis or Valkey, master gate, facilitator or Stripe refuses requests (`503`); an unreachable dashboard makes Caddy answer `502`.

## Limits of this version

- **Admitted before the answer.** Requests are charged when they arrive; with failed-answer credits a 5xx is credited back within about a minute, so a consumer near its limit can be refused meanwhile. Credits need ClickHouse analytics.
- A **crash**, or a stop that kills the process without waiting for it to close (SIGKILL), loses at most the last 5 seconds of counts without shared state, in the consumers' favour. With shared state nothing is lost when a web node stops; only Redis or Valkey losing its data loses the seconds not yet written back.
- **Several replicas on one database** need [shared state](high-availability.md#shared-state-phase-3) to turn monetization on (`409` otherwise): each would charge its own copy of the balances. A replica added later logs a warning every few minutes until shared state is on; each replica still writes what it counted, so usage is never lost or counted twice, but limits can then be exceeded by what the other replicas counted in the last few seconds.
- **Sync replicas** serve monetized hosts only with a mode set on the master (Settings); see [Sync replicas](#sync-replicas-and-pull-replicas) for what they do not do.
- **Postpaid charges** carry no tax (Stripe Tax applies to Checkout only) and are in the install's currency.
- **Switching billing** leaves an open amount below Stripe's minimum charge as a negative balance, and is not possible while replicas gate with shared state.
- **Replicas with allowances** run on at most 16 nodes (processes) each within about five minutes; a seventeenth is refused until the master forgets the oldest.
- **x402**: USDC on Base with the `exact` scheme (EIP-3009) only, as Stripe's x402 takes; prices in whole US cents; Stripe's machine payments are a preview that needs Stablecoins and Crypto enabled on the account, and a live Stripe key (there is no test mode: Base Sepolia is not offered). Replacing or removing the Stripe key turns x402 off. Every paid request waits for the on-chain settlement and Stripe's check. A settlement whose outcome is unknown is not retried: it stays for you to check. The payment payload can appear in Caddy's error log and the WAF's audit log (see [How a request is paid](#how-a-request-is-paid)).
- **Failed-answer credits** can be farmed by a consumer who can make your upstream fail (see [Failed-answer credits](#failed-answer-credits)).
- The per-minute limit is a fixed window per consumer and calendar minute (bursts of up to twice the limit across a minute boundary are possible).
- Browser CORS preflight requests (`OPTIONS`) carry no key and are refused like any other request without one; call monetized APIs from servers, or handle CORS in front.
- A WebSocket connection is one request: it is charged once, when it opens.
- Every request to a monetized host passes through the dashboard process: size it for your API's request rate.
- No invoices or subscriptions: receipts are Stripe's.

## Authentication modes

Monetization is an authentication mode of the host: it cannot be combined with Ingressi forward auth, Authentik or generic forward auth, or a basic-auth access list on the same host. Turning it on for such a host answers `400`, and so does turning one of them on for a monetized host (the proxy host form and `PUT /api/v1/proxy-hosts/{id}` show the message). WAF, geoblocking, mTLS, redirects, path rules, location rules and everything else stay available.

## License

| Action | License |
| --- | --- |
| Create or change plans, consumers (except disabling), API keys, balance adjustments, portal links | `api_monetization` required (`403` otherwise) |
| Turn monetization or x402 on for a host, change it; save Stripe or x402 settings; change retention or replica serving; resume a suspended consumer | required |
| Delete plans or consumers, disable consumers, revoke keys, turn portal links off, turn monetization or x402 off for a host, remove the Stripe keys, turn x402 off, turn replica serving off, remove a saved card, charge an open amount now | never |
| The gate, x402 payments, their settlement and recording, Stripe webhooks, postpaid charges and their reconciliation, failed-answer credits, retention, portal pages and payments, the consumer API, replica allowances | never: everything already set up keeps metering and taking payments when the license lapses |
| Reading every tab and endpoint | never |

## Instance sync, export and history

Plans, consumers, keys, the ledger, payments, host settings, the gate token and the Stripe and x402 settings belong to the master: they are not part of configuration export, import or history, and the settings are not synced. While replica serving is on (Settings), the master sends its replicas the gate's index in the sync payload (settings group `monetization_replica`; see [Sync replicas](#sync-replicas-and-pull-replicas)); fleet revisions get the index of the moment they are pushed. Deleting a proxy host removes its monetization settings.

## REST API

All under `/api/v1/monetization`, documented in the OpenAPI reference (tag "API Monetization"), audited, permission `monetization:read` for `GET`, `monetization:payments` (administrator-level) for `PUT` and `DELETE /stripe` and `/x402`, and `monetization:write` otherwise.

| Method and path | Notes |
| --- | --- |
| `GET`, `POST /plans`; `GET`, `PUT`, `DELETE /plans/{id}` | `{name, pricePerRequestMicros, includedRequestsPerMonth?, requestsPerMinute?, billing?, postpaidCapMicros?, postpaidThresholdMicros?, creditFailedAnswers?, acceptX402?}`. Delete: `409` while consumers or hosts use the plan. Switching billing: `409` while a consumer on it owes anything. |
| `GET`, `POST /consumers`; `GET`, `PUT`, `DELETE /consumers/{id}` | `{name, email?, status?, planId?, overdraftAllowanceMicros?, billing?}`. `{"status": "disabled"}` needs no license. Delete keeps the ledger. The detail lists the 20 latest payments. |
| `GET`, `POST /consumers/{id}/keys`; `DELETE /consumers/{id}/keys/{keyId}` | `POST {name?}` returns `{key, rawKey}` once. Delete revokes. |
| `POST /consumers/{id}/adjust` | `{amountMicros, reason, reference?}`; a repeated `reference` answers `409`. |
| `POST`, `DELETE /consumers/{id}/portal-link` | `POST` returns `{url, token}` once and replaces the previous link. |
| `POST /consumers/{id}/billing/charge` | Postpaid: charges the open amount now; `{status: succeeded \| pending \| failed \| skipped, …}`. |
| `POST /consumers/{id}/billing/resume` | Ends a suspension. |
| `DELETE /consumers/{id}/billing/card` | Removes the saved card (and detaches it in Stripe). |
| `GET /payments` | `?consumerId=&limit=`: Stripe payments (top-ups, charges, open amounts), with refunds and disputes. |
| `GET /hosts`; `GET`, `PUT`, `DELETE /hosts/{proxyHostId}` | `PUT {enabled?, keyHeader?, allowedPlanIds?, x402?: {enabled?, priceCents?}}` (`priceCents` null: the x402 settings' price). |
| `GET`, `PUT`, `DELETE /stripe` | `PUT {secretKey?, webhookSecret?, currency?, topUpAmountsMicros?, topUpUrl?, automaticTax?}`; `DELETE` removes the keys. |
| `GET`, `PUT`, `DELETE /x402` | `PUT {enabled?, priceCents?, network?, cdpKeyId?, cdpKeySecret?}` (turning it on creates the Stripe deposit address once; `409` with Stripe's reason when it cannot); `GET` shows the deposit address, never the secret; `DELETE` turns x402 off and removes the CDP secret. |
| `GET /x402/payments` | `?hostId=&status=&page=&perPage=` |
| `GET`, `PUT /settings` | `{usageRetentionMonths?, replicas?: {mode?: off \| shared \| allowance, gateUrl?}}` |
| `GET /ledger` | `?consumerId=&type=topup\|usage\|adjustment\|credit\|payment\|refund\|dispute&page=&perPage=` |
| `GET /overview` | This and last month's totals, the last 30 days, this month's top consumers and per-consumer usage, the balances held, the last top-up and this month's x402 payments. |

```bash
curl -X POST https://dash.example.com/api/v1/monetization/plans -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"Metered","pricePerRequestMicros":1000,"billing":"postpaid","postpaidCapMicros":50000000}'
curl -X PUT https://dash.example.com/api/v1/monetization/hosts/3 -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"enabled":true,"keyHeader":"X-API-Key","x402":{"enabled":true,"priceCents":2}}'
```

`monetization:payments` sets the Stripe secret key and the x402 settings (the CDP credentials, and turning x402 on, which creates the deposit address), which decide where consumers' payments go: grant it only to people you trust with payments.
