/**
 * API monetization payments: Stripe webhook signature verification and
 * idempotent crediting (also through the route), Checkout Session creation
 * against a mocked Stripe API, the self-service portal (token) and the
 * consumer API (API key).
 */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { insertConsumer, insertKey, insertMonetizedHost, insertPlan, insertProxyHost } from '../helpers/monetization';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

import { encryptSecret } from '../../src/lib/secret';
import { decideGate, pendingUsage, reloadMonetization, resetMonetizationEngineForTests } from '../../ee/monetization/engine';
import { ensureGateSecret, PAYMENTS_SETTING_KEY } from '../../ee/monetization/settings';
import { handleStripeEvent, verifyStripeSignature } from '../../ee/monetization/payments';
import { generatePortalToken } from '../../ee/monetization/keys';
import * as webhookRoute from '../../app/api/monetization/stripe/webhook/route';
import * as portalCheckoutRoute from '../../app/api/monetization/portal/checkout/route';
import * as meRoute from '../../app/api/monetization/me/route';
import * as meCheckoutRoute from '../../app/api/monetization/me/checkout/route';
import * as gateRoute from '../../app/api/monetization/gate/route';
import ApiPortalPage from '../../app/api-portal/[token]/page';
import { first } from '@/src/lib/db/ops';

const WEBHOOK_SECRET = 'whsec_testSigningSecret0123456789';
const SECRET_KEY = 'sk_test_51Habcdefghijklmnop';

async function savePayments(values: Record<string, unknown> = {}) {
  const value = JSON.stringify({
    secretKey: encryptSecret(SECRET_KEY),
    webhookSecret: encryptSecret(WEBHOOK_SECRET),
    currency: 'usd',
    topUpAmountsMicros: [10_000_000, 25_000_000],
    ...values,
  });
  const updatedAt = new Date().toISOString();
  await ctx.db
    .insert(schema.settings)
    .values({ key: PAYMENTS_SETTING_KEY, value, updatedAt })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt } });
}

function sign(body: string, secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

async function checkoutEvent(consumerId: number, overrides: Record<string, unknown> = {}, type = 'checkout.session.completed') {
  return {
    id: 'evt_1',
    type,
    data: {
      object: {
        id: 'cs_test_a1B2c3',
        object: 'checkout.session',
        mode: 'payment',
        payment_status: 'paid',
        amount_total: 1000,
        currency: 'usd',
        metadata: { ingressi_install: (await ensureGateSecret()).installId, ingressi_consumer_id: String(consumerId) },
        ...overrides,
      },
    },
  };
}

async function balanceOf(consumerId: number): Promise<number> {
  return (await first(ctx.db.select().from(schema.monetizationConsumers).where(eq(schema.monetizationConsumers.id, consumerId)).limit(1)))!.balanceMicros;
}

function webhookRequest(body: string, signature: string | null) {
  return new Request('http://localhost/api/monetization/stripe/webhook', {
    method: 'POST',
    headers: signature ? { 'stripe-signature': signature, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    body,
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  ctx.db = createTestDb();
  resetMonetizationEngineForTests();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('Stripe signature verification', () => {
  const body = Buffer.from('{"id":"evt_1","type":"checkout.session.completed"}');
  const now = 1_790_000_000;
  const header = (secret = WEBHOOK_SECRET, timestamp = now, payload = body) =>
    `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.`).update(payload).digest('hex')}`;

  it('accepts the signature Stripe computes', () => {
    expect(verifyStripeSignature(body, header(), WEBHOOK_SECRET, now)).toBe(true);
    // Any one of several v1 signatures (secret rotation), v0 ignored.
    expect(verifyStripeSignature(body, `t=${now},v1=${'0'.repeat(64)},${header().split(',')[1]},v0=abc`, WEBHOOK_SECRET, now)).toBe(true);
  });

  it('refuses a wrong secret, a changed body, a stale or future timestamp and malformed headers', () => {
    expect(verifyStripeSignature(body, header('whsec_other'), WEBHOOK_SECRET, now)).toBe(false);
    expect(verifyStripeSignature(Buffer.from(`${body} `), header(), WEBHOOK_SECRET, now)).toBe(false);
    expect(verifyStripeSignature(body, header(WEBHOOK_SECRET, now - 301), WEBHOOK_SECRET, now)).toBe(false);
    expect(verifyStripeSignature(body, header(WEBHOOK_SECRET, now + 301), WEBHOOK_SECRET, now)).toBe(false);
    expect(verifyStripeSignature(body, header(WEBHOOK_SECRET, now - 299), WEBHOOK_SECRET, now)).toBe(true);
    for (const bad of [null, '', `t=${now}`, `v1=${'a'.repeat(64)}`, `t=abc,v1=${'a'.repeat(64)}`, header().replace('v1=', 'v0=')]) {
      expect(verifyStripeSignature(body, bad, WEBHOOK_SECRET, now)).toBe(false);
    }
  });
});

describe('crediting checkout sessions', () => {
  it('credits a paid session once, however often Stripe delivers it', async () => {
    const consumer = await insertConsumer(ctx.db);
    await reloadMonetization();
    const event = await checkoutEvent(consumer.id);
    expect(await handleStripeEvent(event)).toEqual({ handled: true, consumerId: consumer.id, amountMicros: 10_000_000, duplicate: false });
    expect(await handleStripeEvent(event)).toMatchObject({ handled: true, duplicate: true });
    // The async-payment event of the same session does not credit again.
    expect(await handleStripeEvent(await checkoutEvent(consumer.id, {}, 'checkout.session.async_payment_succeeded'))).toMatchObject({ duplicate: true });
    expect(await balanceOf(consumer.id)).toBe(10_000_000);
    const ledger = await ctx.db.select().from(schema.monetizationLedger);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ type: 'topup', amountMicros: 10_000_000, externalReference: 'stripe:cs_test_a1B2c3', balanceAfterMicros: 10_000_000 });
  });

  it('credits an asynchronous payment when it succeeds, not when the session completes unpaid', async () => {
    const consumer = await insertConsumer(ctx.db);
    expect(await handleStripeEvent(await checkoutEvent(consumer.id, { payment_status: 'unpaid' }))).toMatchObject({ handled: false, reason: 'not paid yet' });
    expect(await balanceOf(consumer.id)).toBe(0);
    expect(await handleStripeEvent(await checkoutEvent(consumer.id, {}, 'checkout.session.async_payment_succeeded'))).toMatchObject({ handled: true, duplicate: false });
    expect(await balanceOf(consumer.id)).toBe(10_000_000);
  });

  it('ignores sessions of other installs or products, other currencies, other events and unknown consumers', async () => {
    const consumer = await insertConsumer(ctx.db);
    const cases: Array<[unknown, string]> = [
      [await checkoutEvent(consumer.id, { metadata: { ingressi_install: 'another-install', ingressi_consumer_id: String(consumer.id) } }), 'session of another install or product'],
      [await checkoutEvent(consumer.id, { metadata: {} }), 'session of another install or product'],
      [await checkoutEvent(consumer.id, { currency: 'eur' }), 'currency mismatch'],
      [await checkoutEvent(consumer.id, { mode: 'subscription' }), 'not a payment session'],
      [await checkoutEvent(consumer.id, { amount_total: 0 }), 'no amount'],
      [await checkoutEvent(consumer.id + 100), 'unknown consumer'],
      [{ type: 'payment_intent.succeeded', data: { object: {} } }, 'payment of another install or product'],
      [{ type: 'customer.created', data: { object: {} } }, 'event type not used'],
    ];
    for (const [event, reason] of cases) expect(await handleStripeEvent(event)).toEqual({ handled: false, reason });
    expect(await balanceOf(consumer.id)).toBe(0);
  });

  it('converts Stripe amounts by the currency decimals (JPY has none)', async () => {
    await savePayments({ currency: 'jpy', topUpAmountsMicros: [] });
    const consumer = await insertConsumer(ctx.db);
    expect(await handleStripeEvent(await checkoutEvent(consumer.id, { currency: 'jpy', amount_total: 500 }))).toMatchObject({ amountMicros: 500_000_000 });
  });

  it('verifies the signature in the webhook route, credits, and lets the next gated request through', async () => {
    await savePayments();
    const plan = await insertPlan(ctx.db, { pricePerRequestMicros: 1_000_000 });
    const consumer = await insertConsumer(ctx.db, { planId: plan.id });
    const { raw } = await insertKey(ctx.db, consumer.id);
    const host = await insertProxyHost(ctx.db);
    await insertMonetizedHost(ctx.db, host.id);
    const token = (await ensureGateSecret()).token;
    await reloadMonetization();
    const gate = () => decideGate({ gateToken: token, hostId: String(host.id), header: (name) => (name === 'authorization' ? `Bearer ${raw}` : null) });
    expect(gate()).toMatchObject({ status: 402 });

    const body = JSON.stringify(await checkoutEvent(consumer.id));
    expect((await webhookRoute.POST(webhookRequest(body, null))).status).toBe(400);
    expect((await webhookRoute.POST(webhookRequest(body, sign(body, 'whsec_wrong')))).status).toBe(400);
    expect((await webhookRoute.POST(webhookRequest(body.replace('1000', '100000'), sign(body)))).status).toBe(400);
    expect(await balanceOf(consumer.id)).toBe(0);

    const ok = await webhookRoute.POST(webhookRequest(body, sign(body)));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ received: true, credited: true });
    const again = await webhookRoute.POST(webhookRequest(body, sign(body)));
    expect(await again.json()).toEqual({ received: true, credited: false });
    expect(await balanceOf(consumer.id)).toBe(10_000_000);

    // The in-memory balance was refreshed: no reload needed.
    expect(gate()).toMatchObject({ allow: true, chargedMicros: 1_000_000 });

    const other = JSON.stringify({ type: 'customer.created', data: { object: {} } });
    expect(await (await webhookRoute.POST(webhookRequest(other, sign(other)))).json()).toEqual({ received: true, ignored: 'event type not used' });
  });

  it('answers 503 until a webhook secret is configured', async () => {
    const body = '{}';
    expect((await webhookRoute.POST(webhookRequest(body, sign(body)))).status).toBe(503);
  });
});

describe('top-ups through Stripe Checkout', () => {
  function stripeReturns(url = 'https://checkout.stripe.com/c/pay/cs_test_a1B2c3') {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'cs_test_a1B2c3', url }), { status: 200, headers: { 'content-type': 'application/json' } }));
  }

  async function portalConsumer(values: Record<string, unknown> = {}) {
    const { token, hash } = generatePortalToken();
    const consumer = await insertConsumer(ctx.db, { email: 'dev@example.com', portalTokenHash: hash, ...values });
    return { token, consumer };
  }

  function portalCheckout(body: unknown) {
    return portalCheckoutRoute.POST(new Request('http://localhost/api/monetization/portal/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
  }

  it('creates a payment-mode Checkout Session with the consumer and install in its metadata', async () => {
    await savePayments();
    stripeReturns();
    const { token, consumer } = await portalConsumer();
    const response = await portalCheckout({ token, amountMicros: 25_000_000 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_a1B2c3' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${SECRET_KEY}`);
    expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    const form = new URLSearchParams(init.body as string);
    expect(form.get('mode')).toBe('payment');
    expect(form.get('line_items[0][price_data][currency]')).toBe('usd');
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('2500');
    expect(form.get('line_items[0][quantity]')).toBe('1');
    expect(form.get('metadata[ingressi_consumer_id]')).toBe(String(consumer.id));
    expect(form.get('metadata[ingressi_install]')).toBe((await ensureGateSecret()).installId);
    expect(form.get('customer_email')).toBe('dev@example.com');
    expect(form.get('success_url')).toMatch(new RegExp(`/api-portal/${token}\\?topup=success$`));
    expect(form.get('cancel_url')).toMatch(new RegExp(`/api-portal/${token}\\?topup=cancelled$`));
  });

  it('refuses unknown tokens, disabled consumers, amounts not offered and an unconfigured Stripe', async () => {
    const { token } = await portalConsumer();
    expect((await portalCheckout({ token, amountMicros: 10_000_000 })).status).toBe(409); // Stripe not configured
    await savePayments();
    stripeReturns();
    expect((await portalCheckout({ token: generatePortalToken().token, amountMicros: 10_000_000 })).status).toBe(404);
    expect((await portalCheckout({ token: 'short', amountMicros: 10_000_000 })).status).toBe(404);
    expect((await portalCheckout({ token, amountMicros: 7_000_000 })).status).toBe(400);
    expect((await portalCheckout({ token, amountMicros: '10' })).status).toBe(400);
    const disabled = await portalConsumer({ status: 'disabled', name: 'Off' });
    expect((await portalCheckout({ token: disabled.token, amountMicros: 10_000_000 })).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 502 without Stripe details when Stripe refuses', async () => {
    await savePayments();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'amount_too_small', message: `secret ${SECRET_KEY}` } }), { status: 400 }));
    const { token } = await portalConsumer();
    const response = await portalCheckout({ token, amountMicros: 10_000_000 });
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain('amount_too_small');
    expect(text).not.toContain(SECRET_KEY);
  });

  it('limits checkout attempts per consumer', async () => {
    await savePayments();
    stripeReturns();
    const { token } = await portalConsumer();
    for (let i = 0; i < 10; i += 1) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ url: 'https://checkout.stripe.com/x' }), { status: 200 }));
      expect((await portalCheckout({ token, amountMicros: 10_000_000 })).status).toBe(200);
    }
    expect((await portalCheckout({ token, amountMicros: 10_000_000 })).status).toBe(429);
  });
});

describe('portal page and consumer API', () => {
  it('renders the portal for a valid token and nothing for an unknown one', async () => {
    await savePayments();
    const plan = await insertPlan(ctx.db, { name: 'Gold', pricePerRequestMicros: 500, includedRequestsPerMonth: 100 });
    const { token, hash } = generatePortalToken();
    const consumer = await insertConsumer(ctx.db, { planId: plan.id, balanceMicros: 3_000_000, portalTokenHash: hash });
    const page = await ApiPortalPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve({ topup: 'success' }) });
    expect(page.props).toMatchObject({
      mode: 'token',
      token,
      result: 'topup-success',
      initial: {
        consumer: { id: consumer.id, name: 'Acme', status: 'active' },
        plan: { name: 'Gold', pricePerRequestMicros: 500 },
        balanceMicros: 3_000_000,
        includedRequestsRemaining: 100,
        topUpsAvailable: true,
        topUpAmountsMicros: [10_000_000, 25_000_000],
      },
    });
    const unknown = await ApiPortalPage({ params: Promise.resolve({ token: generatePortalToken().token }), searchParams: Promise.resolve({}) });
    expect(unknown.props).toMatchObject({ initial: null, token: undefined });
  });

  it('serves the balance and recent usage to the consumer with its own API key', async () => {
    await savePayments();
    const plan = await insertPlan(ctx.db, { pricePerRequestMicros: 1_000 });
    const consumer = await insertConsumer(ctx.db, { planId: plan.id, balanceMicros: 5_000 });
    const { raw } = await insertKey(ctx.db, consumer.id);
    const host = await insertProxyHost(ctx.db);
    await insertMonetizedHost(ctx.db, host.id);
    const token = (await ensureGateSecret()).token;
    await reloadMonetization();
    decideGate({ gateToken: token, hostId: String(host.id), header: (name) => (name === 'authorization' ? `Bearer ${raw}` : null) });
    expect(pendingUsage(consumer.id).chargeMicros).toBe(1_000);

    const me = (headers: Record<string, string>) => meRoute.GET(new Request('http://localhost/api/monetization/me', { headers }));
    expect((await me({})).status).toBe(401);
    expect((await me({ authorization: 'Bearer ik_000000000000_nope' })).status).toBe(401);
    const keyHeaders: Array<Record<string, string>> = [{ authorization: `Bearer ${raw}` }, { 'x-api-key': raw }];
    for (const headers of keyHeaders) {
      const response = await me(headers);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ consumer: { id: consumer.id }, balanceMicros: 4_000, currency: 'usd', topUpsAvailable: true });
      expect(JSON.stringify(body)).not.toContain(raw);
    }

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ url: 'https://checkout.stripe.com/x' }), { status: 200 }));
    const checkout = await meCheckoutRoute.POST(new Request('http://localhost/api/monetization/me/checkout', {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify({ amountMicros: 10_000_000 }),
    }));
    expect(checkout.status).toBe(200);
    const form = new URLSearchParams((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(form.get('success_url')).toMatch(/\/api-portal\?topup=success$/);
  });

  it('serves the gate route', async () => {
    const plan = await insertPlan(ctx.db, { pricePerRequestMicros: 0 });
    const consumer = await insertConsumer(ctx.db, { planId: plan.id });
    const { raw } = await insertKey(ctx.db, consumer.id);
    const host = await insertProxyHost(ctx.db);
    await insertMonetizedHost(ctx.db, host.id);
    const token = (await ensureGateSecret()).token;
    const response = await gateRoute.GET(new Request('http://web:3000/api/monetization/gate', {
      headers: { 'X-Ingressi-Gate-Token': token, 'X-Ingressi-Host-Id': String(host.id), Authorization: `Bearer ${raw}` },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Ingressi-Consumer-Id')).toBe(String(consumer.id));
    const direct = await gateRoute.GET(new Request('http://web:3000/api/monetization/gate', { headers: { Authorization: `Bearer ${raw}` } }));
    expect(direct.status).toBe(403);
  });
});
