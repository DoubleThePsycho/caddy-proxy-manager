/**
 * Postpaid consumers (ee/monetization/postpaid.ts) against a mocked Stripe
 * API: the gate admits usage only with a usable saved card and never past
 * the plan's cap; cards are saved through Checkout in setup mode; the saved
 * card is charged off-session at the threshold and at the end of the
 * period, once per charge whichever of the API answer and the webhook comes
 * first, and charges whose answer was lost are reconciled with their
 * idempotency key; a failed charge suspends the consumer until the open
 * amount is paid in Checkout; refunds and disputes come off the balance once
 * (also when they arrive together, or before their payment was recorded)
 * and a dispute suspends until an administrator resumes; a key Stripe
 * refuses suspends nobody; switching billing charges the open amount first.
 * Nothing calls Stripe for real.
 */
import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { installLicense, licenseSigner } from '../helpers/config-fixture';
import { insertConsumer, insertKey, insertMonetizedHost, insertPlan, insertProxyHost } from '../helpers/monetization';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('../../src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-auth')>();
  return { ...actual, requireApiPermission: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }) };
});

import { encryptSecret } from '../../src/lib/secret';
import { setTrustedLicenseKeysForTests } from '../../ee/licensing/public-keys';
import { decideGate, flushUsage, reloadMonetization, resetMonetizationEngineForTests, type GateDecision } from '../../ee/monetization/engine';
import { gateResponse } from '../../ee/monetization/gate-response';
import { ensureGateSecret, PAYMENTS_SETTING_KEY } from '../../ee/monetization/settings';
import { handleStripeEvent } from '../../ee/monetization/payments';
import {
  chargeOpenAmount,
  clearStaleSwitchSuspensions,
  createCardSetupCheckout,
  createOpenAmountCheckout,
  reconcilePendingCharges,
  runPostpaidBilling,
} from '../../ee/monetization/postpaid';
import { listConsumers } from '../../ee/monetization/consumers';
import { monetizationAttentionProvider } from '../../ee/monetization/attention';
import { logAuditEvent } from '../../src/lib/audit';
import * as plansRoute from '../../app/api/v1/monetization/plans/route';
import * as planRoute from '../../app/api/v1/monetization/plans/[id]/route';
import * as consumersRoute from '../../app/api/v1/monetization/consumers/route';
import * as consumerRoute from '../../app/api/v1/monetization/consumers/[id]/route';
import * as chargeRoute from '../../app/api/v1/monetization/consumers/[id]/billing/charge/route';
import * as resumeRoute from '../../app/api/v1/monetization/consumers/[id]/billing/resume/route';
import * as cardRoute from '../../app/api/v1/monetization/consumers/[id]/billing/card/route';
import * as webhookRoute from '../../app/api/monetization/stripe/webhook/route';
import { first } from '@/src/lib/db/ops';

const SECRET_KEY = 'sk_test_51Habcdefghijklmnop';
const WEBHOOK_SECRET = 'whsec_testSigningSecret0123456789';
const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const USD = 1_000_000;

type StripeCall = { method: string; path: string; params: URLSearchParams; idempotencyKey: string | null };
const stripe = vi.hoisted(() => ({
  consumerId: 0,
  calls: [] as Array<{ method: string; path: string; params: URLSearchParams; idempotencyKey: string | null }>,
  /** What POST /v1/payment_intents answers next (a function of the call), or throws. */
  paymentIntent: null as null | ((call: { params: URLSearchParams; idempotencyKey: string | null }) => Response),
  /** The Checkout Sessions GET /v1/checkout/sessions lists (null: Stripe cannot be reached). */
  sessions: [] as Array<Record<string, unknown>> | null,
}));

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const CARD = { id: 'pm_card1', customer: 'cus_test1', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } };

async function fakeStripe(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  expect(url.origin).toBe('https://api.stripe.com');
  const method = init?.method ?? 'GET';
  const headers = (init?.headers ?? {}) as Record<string, string>;
  expect(headers.Authorization).toBe(`Bearer ${SECRET_KEY}`);
  const params = method === 'POST' ? new URLSearchParams(String(init?.body ?? '')) : url.searchParams;
  const call: StripeCall = { method, path: url.pathname, params, idempotencyKey: headers['Idempotency-Key'] ?? null };
  stripe.calls.push(call);
  if (method === 'POST' && url.pathname === '/v1/customers') return json(200, { id: 'cus_test1', object: 'customer' });
  if (method === 'POST' && url.pathname === '/v1/checkout/sessions') return json(200, { id: 'cs_test_x', url: 'https://checkout.stripe.com/c/pay/cs_test_x' });
  if (method === 'GET' && url.pathname === '/v1/payment_methods/pm_card1') return json(200, CARD);
  if (method === 'GET' && url.pathname.startsWith('/v1/payment_intents/pi_')) {
    return json(200, {
      id: url.pathname.split('/').pop(),
      status: 'succeeded',
      setup_future_usage: 'off_session',
      customer: 'cus_test1',
      metadata: { ingressi_install: (await ensureGateSecret()).installId, ingressi_consumer_id: String(stripe.consumerId) },
      payment_method: { ...CARD, id: 'pm_card2', card: { ...CARD.card, last4: '1881' } },
    });
  }
  if (method === 'POST' && url.pathname === '/v1/payment_intents') {
    if (!stripe.paymentIntent) throw new Error('unexpected charge');
    return stripe.paymentIntent(call);
  }
  if (method === 'POST' && url.pathname.endsWith('/detach')) return json(200, { id: 'pm_card1' });
  if (method === 'GET' && url.pathname === '/v1/checkout/sessions') {
    if (stripe.sessions === null) throw new TypeError('fetch failed');
    return json(200, { object: 'list', data: stripe.sessions.filter((session) => session.payment_intent === url.searchParams.get('payment_intent')) });
  }
  throw new Error(`unexpected Stripe call ${method} ${url.pathname}`);
}

function succeeded(amountMinor?: number) {
  return (call: { params: URLSearchParams }) =>
    json(200, { id: `pi_ok${call.params.get('metadata[ingressi_charge_id]')}`, object: 'payment_intent', status: 'succeeded', amount_received: amountMinor ?? Number(call.params.get('amount')), currency: 'usd' });
}

function declined(code: string, decline?: string) {
  return (call: { params: URLSearchParams }) =>
    json(402, { error: { type: 'card_error', code, ...(decline ? { decline_code: decline } : {}), payment_intent: { id: `pi_fail${call.params.get('metadata[ingressi_charge_id]')}`, status: 'requires_payment_method' } } });
}

async function savePayments(values: Record<string, unknown> = {}) {
  const value = JSON.stringify({ secretKey: encryptSecret(SECRET_KEY), webhookSecret: encryptSecret(WEBHOOK_SECRET), currency: 'usd', topUpAmountsMicros: [10 * USD], ...values });
  const updatedAt = new Date().toISOString();
  await ctx.db.insert(schema.settings).values({ key: PAYMENTS_SETTING_KEY, value, updatedAt }).onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt } });
}

type World = { token: string; hostId: number; consumerId: number; key: string; planId: number };

async function seed(options: { card?: boolean; price?: number; cap?: number; threshold?: number | null; balance?: number; suspended?: string | null; expMonth?: number; expYear?: number } = {}): Promise<World> {
  const plan = await insertPlan(ctx.db, {
    pricePerRequestMicros: options.price ?? USD,
    billing: 'postpaid',
    postpaidCapMicros: options.cap ?? 50 * USD,
    postpaidThresholdMicros: options.threshold === undefined ? 20 * USD : options.threshold,
  });
  const card = options.card ?? true;
  const consumer = await insertConsumer(ctx.db, {
    planId: plan.id,
    balanceMicros: options.balance ?? 0,
    email: 'dev@example.com',
    stripeCustomerId: card ? 'cus_test1' : null,
    paymentMethodId: card ? 'pm_card1' : null,
    cardBrand: card ? 'visa' : null,
    cardLast4: card ? '4242' : null,
    cardExpMonth: card ? options.expMonth ?? 12 : null,
    cardExpYear: card ? options.expYear ?? 2030 : null,
    suspendedAt: options.suspended ? new Date(T0).toISOString() : null,
    suspendedReason: options.suspended ?? null,
    billedPeriod: '2026-09',
  });
  stripe.consumerId = consumer.id;
  const { raw } = await insertKey(ctx.db, consumer.id);
  const host = await insertProxyHost(ctx.db);
  await insertMonetizedHost(ctx.db, host.id);
  const { token } = await ensureGateSecret();
  await reloadMonetization({ quiet: true });
  return { token, hostId: host.id, consumerId: consumer.id, key: raw, planId: plan.id };
}

function call(world: World, now = T0): GateDecision {
  return decideGate({ gateToken: world.token, hostId: String(world.hostId), header: (name) => (name === 'authorization' ? `Bearer ${world.key}` : null), now });
}

function calls(world: World, count: number): GateDecision[] {
  return Array.from({ length: count }, () => call(world));
}

async function consumerRow(id: number) {
  return (await first(ctx.db.select().from(schema.monetizationConsumers).where(eq(schema.monetizationConsumers.id, id)).limit(1)))!;
}

async function ledger(consumerId: number, type?: string) {
  return (await ctx.db.select().from(schema.monetizationLedger).where(eq(schema.monetizationLedger.consumerId, consumerId))).filter((row) => !type || row.type === type);
}

async function payments(consumerId: number) {
  return await ctx.db.select().from(schema.monetizationPayments).where(eq(schema.monetizationPayments.consumerId, consumerId));
}

const chargesSent = () => stripe.calls.filter((entry) => entry.method === 'POST' && entry.path === '/v1/payment_intents');

function req(method: string, path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

beforeEach(async () => {
  ctx.db = createTestDb();
  resetMonetizationEngineForTests();
  stripe.calls = [];
  stripe.paymentIntent = null;
  stripe.sessions = [];
  vi.stubGlobal('fetch', vi.fn(fakeStripe));
  vi.spyOn(Date, 'now').mockReturnValue(T0);
  setTrustedLicenseKeysForTests(licenseSigner.keys);
  await installLicense(ctx.db, 'enterprise');
  await savePayments();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => setTrustedLicenseKeysForTests(null));

describe('the gate', () => {
  it('admits a postpaid consumer only with a usable card, up to the cap, and says what is owed', async () => {
    const noCard = await seed({ card: false, cap: 3 * USD });
    expect(call(noCard)).toMatchObject({ allow: false, status: 402, error: 'payment_method_required' });
    const body = await gateResponse(call(noCard)).json();
    expect(body).toMatchObject({ error: 'payment_method_required', paymentUrl: expect.stringMatching(/\/api-portal$/) });

    const world = await seed({ cap: 3 * USD });
    expect(calls(world, 3).every((decision) => decision.allow)).toBe(true);
    const refused = call(world);
    expect(refused).toMatchObject({ allow: false, status: 402, error: 'usage_cap_reached', openAmountMicros: 3 * USD, capMicros: 3 * USD });
    const response = gateResponse(refused);
    expect(response.headers.get('link')).toMatch(/rel="payment"/);
    expect(await response.json()).toMatchObject({ error: 'usage_cap_reached', openAmount: '3.00', cap: '3.00', currency: 'USD' });
  });

  it('refuses an expired card and a suspended consumer', async () => {
    const expired = await seed({ expMonth: 9, expYear: 2026 });
    expect(call(expired)).toMatchObject({ allow: false, status: 402, error: 'payment_method_required' });
    const suspended = await seed({ suspended: 'payment_failed' });
    expect(call(suspended)).toMatchObject({ allow: false, status: 402, error: 'payment_overdue', reason: 'payment_failed' });
    expect(await gateResponse(call(suspended)).json()).toMatchObject({ message: 'A charge of the saved card failed; pay the open amount to continue' });
  });
});

describe('saving a card', () => {
  it('creates the Stripe Customer once and a setup-mode Checkout Session with the install and consumer', async () => {
    const world = await seed({ card: false });
    await ctx.db.update(schema.monetizationConsumers).set({ stripeCustomerId: null }).where(eq(schema.monetizationConsumers.id, world.consumerId));
    const url = await createCardSetupCheckout(world.consumerId, { successUrl: 'https://dash.example.com/api-portal?card=saved', cancelUrl: 'https://dash.example.com/api-portal?card=cancelled' });
    expect(url).toBe('https://checkout.stripe.com/c/pay/cs_test_x');
    const [customer, session] = stripe.calls;
    expect(customer.path).toBe('/v1/customers');
    expect(customer.idempotencyKey).toMatch(/^ingressi-.+-customer-\d+-[a-f0-9]{16}$/);
    const installId = (await ensureGateSecret()).installId;
    expect(customer.params.get('metadata[ingressi_install]')).toBe(installId);
    expect(customer.params.get('metadata[ingressi_consumer_id]')).toBe(String(world.consumerId));
    expect(session.path).toBe('/v1/checkout/sessions');
    expect(session.params.get('mode')).toBe('setup');
    expect(session.params.get('customer')).toBe('cus_test1');
    expect(session.params.get('setup_intent_data[metadata][ingressi_install]')).toBe(installId);
    expect(session.params.get('setup_intent_data[metadata][ingressi_consumer_id]')).toBe(String(world.consumerId));
    expect((await consumerRow(world.consumerId)).stripeCustomerId).toBe('cus_test1');
  });

  it('saves brand, last four and expiry from setup_intent.succeeded, only for this install and customer', async () => {
    const world = await seed({ card: false });
    const installId = (await ensureGateSecret()).installId;
    const intent = (values: Record<string, unknown> = {}) => ({
      type: 'setup_intent.succeeded',
      data: { object: { id: 'seti_1', status: 'succeeded', customer: 'cus_test1', payment_method: 'pm_card1', metadata: { ingressi_install: installId, ingressi_consumer_id: String(world.consumerId) }, ...values } },
    });
    expect(await handleStripeEvent(intent({ metadata: { ingressi_install: 'other', ingressi_consumer_id: String(world.consumerId) } }))).toMatchObject({ handled: false });
    expect(await handleStripeEvent(intent({ customer: 'cus_someoneelse' }))).toMatchObject({ handled: false, reason: 'customer mismatch' });
    expect(await handleStripeEvent(intent({ status: 'requires_payment_method' }))).toMatchObject({ handled: false });
    expect(await handleStripeEvent(intent())).toMatchObject({ handled: true, consumerId: world.consumerId });
    const row = await consumerRow(world.consumerId);
    expect(row).toMatchObject({ paymentMethodId: 'pm_card1', cardBrand: 'visa', cardLast4: '4242', cardExpMonth: 12, cardExpYear: 2030 });
    expect(call(world)).toMatchObject({ allow: true });
  });
});

describe('charging the saved card', () => {
  it('charges the open amount at the threshold, once, whether the API or the webhook reports it first', async () => {
    const world = await seed();
    stripe.paymentIntent = succeeded();
    expect(calls(world, 21).every((decision) => decision.allow)).toBe(true);
    await flushUsage(T0);
    expect(await runPostpaidBilling(T0)).toEqual({ charged: 1 });
    const [sent] = chargesSent();
    expect(sent.params.get('amount')).toBe('2100');
    expect(sent.params.get('currency')).toBe('usd');
    expect(sent.params.get('customer')).toBe('cus_test1');
    expect(sent.params.get('payment_method')).toBe('pm_card1');
    expect(sent.params.get('off_session')).toBe('true');
    expect(sent.params.get('confirm')).toBe('true');
    expect(sent.params.get('metadata[ingressi_install]')).toBe((await ensureGateSecret()).installId);
    expect(sent.idempotencyKey).toMatch(/^ingressi-.+-charge-[0-9a-f-]{36}$/);
    expect((await consumerRow(world.consumerId)).balanceMicros).toBe(0);
    const [payment] = await payments(world.consumerId);
    expect(payment).toMatchObject({ kind: 'charge', reason: 'threshold', status: 'succeeded', amountMicros: 21 * USD, paymentMethodId: 'pm_card1' });
    expect(await ledger(world.consumerId, 'payment')).toHaveLength(1);

    // The webhook of the same PaymentIntent credits nothing more.
    const event = { type: 'payment_intent.succeeded', data: { object: { id: payment.paymentIntentId, status: 'succeeded', amount_received: 2100, currency: 'usd', metadata: { ingressi_install: (await ensureGateSecret()).installId, ingressi_consumer_id: String(world.consumerId), ingressi_charge_id: String(payment.id) } } } };
    expect(await handleStripeEvent(event)).toMatchObject({ handled: true });
    expect(await ledger(world.consumerId, 'payment')).toHaveLength(1);
    expect((await consumerRow(world.consumerId)).balanceMicros).toBe(0);
    // Below the threshold now: nothing more is charged.
    expect(await runPostpaidBilling(T0 + 60_000)).toEqual({ charged: 0 });
    expect(chargesSent()).toHaveLength(1);
  });

  it('charges at the end of the period once, even below the threshold, but not below Stripe\'s minimum', async () => {
    const world = await seed();
    stripe.paymentIntent = succeeded();
    calls(world, 3);
    await flushUsage(T0);
    const november = Date.UTC(2026, 10, 1, 0, 1);
    expect(await runPostpaidBilling(november)).toEqual({ charged: 1 });
    expect(chargesSent()[0].params.get('amount')).toBe('300');
    const [payment] = await payments(world.consumerId);
    expect(payment).toMatchObject({ reason: 'period', period: '2026-10' });
    expect((await consumerRow(world.consumerId)).billedPeriod).toBe('2026-10');
    calls(world, 1);
    await flushUsage(november);
    expect(await runPostpaidBilling(november + 60_000)).toEqual({ charged: 0 });

    const small = await seed({ price: 100_000 });
    calls(small, 1);
    await flushUsage(T0);
    await runPostpaidBilling(Date.UTC(2026, 10, 1, 0, 2));
    expect((await payments(small.consumerId)).length).toBe(0);
    expect((await consumerRow(small.consumerId)).billedPeriod).toBe('2026-10');
  });

  it('suspends on a declined charge; paying the open amount in Checkout credits it, ends the suspension and saves the card', async () => {
    const world = await seed();
    stripe.paymentIntent = declined('card_declined', 'insufficient_funds');
    calls(world, 21);
    await flushUsage(T0);
    expect(await chargeOpenAmount(world.consumerId, 'threshold', { now: T0 })).toMatchObject({ status: 'failed', code: 'card_declined' });
    expect(await consumerRow(world.consumerId)).toMatchObject({ suspendedReason: 'payment_failed' });
    expect((await payments(world.consumerId))[0]).toMatchObject({ status: 'failed', failureCode: 'card_declined', paymentIntentId: expect.stringMatching(/^pi_fail/) });
    expect(call(world)).toMatchObject({ allow: false, status: 402, error: 'payment_overdue' });
    // No automatic charge while suspended.
    expect(await runPostpaidBilling(T0 + 60_000)).toEqual({ charged: 0 });

    const url = await createOpenAmountCheckout(world.consumerId, { successUrl: 'https://dash.example.com/a', cancelUrl: 'https://dash.example.com/b' });
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const session = stripe.calls.find((entry) => entry.path === '/v1/checkout/sessions')!;
    expect(session.params.get('mode')).toBe('payment');
    expect(session.params.get('customer')).toBe('cus_test1');
    expect(session.params.get('line_items[0][price_data][unit_amount]')).toBe('2100');
    expect(session.params.get('metadata[ingressi_kind]')).toBe('open_amount');
    expect(session.params.get('payment_intent_data[setup_future_usage]')).toBe('off_session');

    const paid = {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_open', mode: 'payment', payment_status: 'paid', amount_total: 2100, amount_subtotal: 2100, currency: 'usd', payment_intent: 'pi_open1', metadata: { ingressi_install: (await ensureGateSecret()).installId, ingressi_consumer_id: String(world.consumerId), ingressi_kind: 'open_amount' } } },
    };
    expect(await handleStripeEvent(paid)).toMatchObject({ handled: true, amountMicros: 21 * USD, duplicate: false });
    expect(await handleStripeEvent(paid)).toMatchObject({ duplicate: true });
    const row = await consumerRow(world.consumerId);
    expect(row).toMatchObject({ balanceMicros: 0, suspendedAt: null, suspendedReason: null, paymentMethodId: 'pm_card2', cardLast4: '1881' });
    expect((await ledger(world.consumerId, 'payment'))).toHaveLength(1);
    expect((await payments(world.consumerId)).find((payment) => payment.kind === 'open_amount')).toMatchObject({ paymentIntentId: 'pi_open1', status: 'succeeded' });
    expect(call(world)).toMatchObject({ allow: true });
  });

  it('suspends with the reason when the bank asks the card holder to confirm', async () => {
    const world = await seed();
    stripe.paymentIntent = declined('authentication_required');
    calls(world, 21);
    await flushUsage(T0);
    expect(await chargeOpenAmount(world.consumerId, 'threshold', { now: T0 })).toMatchObject({ status: 'failed', code: 'authentication_required' });
    expect((await payments(world.consumerId))[0]).toMatchObject({ status: 'requires_action' });
    expect(call(world)).toMatchObject({ error: 'payment_overdue', reason: 'authentication_required' });
  });

  it('leaves an amount Stripe finds too small open without suspending', async () => {
    const world = await seed();
    stripe.paymentIntent = () => json(400, { error: { type: 'invalid_request_error', code: 'amount_too_small' } });
    calls(world, 21);
    await flushUsage(T0);
    expect(await chargeOpenAmount(world.consumerId, 'threshold', { now: T0 })).toMatchObject({ status: 'failed', code: 'amount_too_small' });
    expect((await consumerRow(world.consumerId)).suspendedAt).toBeNull();
    expect(call(world)).toMatchObject({ allow: true });
  });

  it('keeps a charge whose answer was lost pending, never charges it twice, and reconciles it with the same idempotency key', async () => {
    const world = await seed();
    calls(world, 21);
    await flushUsage(T0);
    stripe.paymentIntent = () => {
      throw new TypeError('fetch failed');
    };
    expect(await chargeOpenAmount(world.consumerId, 'threshold', { now: T0 })).toMatchObject({ status: 'pending' });
    const [pending] = await payments(world.consumerId);
    expect(pending.status).toBe('pending');
    // Counted as on its way: the next pass does not charge the same usage again.
    expect(await runPostpaidBilling(T0 + 60_000)).toEqual({ charged: 0 });
    expect(chargesSent()).toHaveLength(1);
    const views = await listConsumers();
    expect(views.find((view) => view.id === world.consumerId)?.postpaid).toMatchObject({ openAmountMicros: 21 * USD, pendingChargeMicros: 21 * USD });

    // Reconciled after a restart: the same key, so Stripe answers with the first outcome.
    stripe.paymentIntent = succeeded();
    await ctx.db.update(schema.monetizationPayments).set({ updatedAt: new Date(T0 - 120_000).toISOString() }).where(eq(schema.monetizationPayments.id, pending.id));
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 120_000);
    expect(await reconcilePendingCharges(T0 + 120_000)).toEqual({ checked: 1 });
    const sent = chargesSent();
    expect(sent).toHaveLength(2);
    expect(sent[1].idempotencyKey).toBe(sent[0].idempotencyKey);
    expect(sent[1].params.toString()).toBe(sent[0].params.toString());
    expect((await payments(world.consumerId))[0].status).toBe('succeeded');
    expect((await consumerRow(world.consumerId)).balanceMicros).toBe(0);
    expect(await reconcilePendingCharges(T0 + 240_000)).toEqual({ checked: 0 });
  });
});

describe('refunds and disputes', () => {
  async function paidCharge(world: World) {
    stripe.paymentIntent = succeeded();
    calls(world, 21);
    await flushUsage(T0);
    await chargeOpenAmount(world.consumerId, 'threshold', { now: T0 });
    return (await payments(world.consumerId))[0];
  }

  it('takes a refund off the balance once per refunded total', async () => {
    const world = await seed();
    const payment = await paidCharge(world);
    const refund = (total: number) => ({ type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: payment.paymentIntentId, amount_refunded: total, currency: 'usd' } } });
    expect(await handleStripeEvent(refund(500))).toMatchObject({ handled: true, amountMicros: -5 * USD });
    expect(await handleStripeEvent(refund(500))).toMatchObject({ handled: true, duplicate: true });
    expect(await handleStripeEvent(refund(800))).toMatchObject({ handled: true, amountMicros: -3 * USD });
    expect((await consumerRow(world.consumerId)).balanceMicros).toBe(-8 * USD);
    expect((await ledger(world.consumerId, 'refund')).map((row) => row.amountMicros).sort()).toEqual([-5 * USD, -3 * USD].sort());
    expect((await payments(world.consumerId))[0].refundedMicros).toBe(8 * USD);
    expect(await handleStripeEvent({ type: 'charge.refunded', data: { object: { id: 'ch_2', payment_intent: 'pi_unknown', amount_refunded: 100, currency: 'usd' } } })).toMatchObject({ handled: false });
  });

  it('takes two partial refunds arriving together off once: the larger total, not the sum', async () => {
    const world = await seed();
    const payment = await paidCharge(world);
    const balance = (await consumerRow(world.consumerId)).balanceMicros;
    const refund = (total: number) => ({ type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: payment.paymentIntentId, amount_refunded: total, currency: 'usd' } } });
    await Promise.all([handleStripeEvent(refund(300)), handleStripeEvent(refund(500))]);
    expect((await consumerRow(world.consumerId)).balanceMicros).toBe(balance - 5 * USD);
    expect((await payments(world.consumerId))[0].refundedMicros).toBe(5 * USD);
    expect(-(await ledger(world.consumerId, 'refund')).reduce((sum, row) => sum + row.amountMicros, 0)).toBe(5 * USD);
  });

  it('applies a refund that arrives before its top-up was recorded: the payment is looked up in Stripe first, credited once', async () => {
    const world = await seed({ card: false });
    const installId = (await ensureGateSecret()).installId;
    const session = {
      id: 'cs_test_top1', object: 'checkout.session', mode: 'payment', payment_status: 'paid', currency: 'usd',
      amount_total: 2000, amount_subtotal: 2000, payment_intent: 'pi_top1',
      metadata: { ingressi_install: installId, ingressi_consumer_id: String(world.consumerId) },
    };
    const refund = { type: 'charge.refunded', data: { object: { id: 'ch_top1', payment_intent: 'pi_top1', amount_refunded: 500, currency: 'usd' } } };
    // Stripe cannot be asked: the event is not acknowledged, so Stripe sends it again.
    stripe.sessions = null;
    expect(await handleStripeEvent(refund)).toMatchObject({ handled: false, retry: true });
    expect((await consumerRow(world.consumerId)).balanceMicros).toBe(0);
    stripe.sessions = [session];
    expect(await handleStripeEvent(refund)).toMatchObject({ handled: true, amountMicros: -5 * USD });
    expect((await consumerRow(world.consumerId)).balanceMicros).toBe(15 * USD);
    // The top-up's own event, arriving last, credits nothing more.
    expect(await handleStripeEvent({ type: 'checkout.session.completed', data: { object: session } })).toMatchObject({ handled: true, duplicate: true });
    expect((await consumerRow(world.consumerId)).balanceMicros).toBe(15 * USD);
    expect((await ledger(world.consumerId)).map((row) => row.type).sort()).toEqual(['refund', 'topup']);
  });

  it('takes a disputed amount off once and suspends until resumed, which needs the license', async () => {
    const world = await seed();
    const payment = await paidCharge(world);
    const dispute = { type: 'charge.dispute.created', data: { object: { id: 'dp_1', charge: 'ch_1', payment_intent: payment.paymentIntentId, amount: 2100, currency: 'usd' } } };
    expect(await handleStripeEvent(dispute)).toMatchObject({ handled: true, amountMicros: -21 * USD });
    expect(await handleStripeEvent(dispute)).toMatchObject({ duplicate: true });
    expect(await consumerRow(world.consumerId)).toMatchObject({ balanceMicros: -21 * USD, suspendedReason: 'dispute' });
    expect(call(world)).toMatchObject({ error: 'payment_overdue', reason: 'dispute' });
    // A payment does not end a dispute's suspension.
    await ctx.db.delete(schema.settings).where(eq(schema.settings.key, 'license'));
    expect((await resumeRoute.POST(req('POST', '/x'), params(world.consumerId))).status).toBe(403);
    await installLicense(ctx.db, 'enterprise');
    const resumed = await resumeRoute.POST(req('POST', '/x'), params(world.consumerId));
    expect(resumed.status).toBe(200);
    expect((await resumed.json()).postpaid).toMatchObject({ state: 'active', suspendedReason: null });
    expect(call(world)).toMatchObject({ allow: true });
  });
});

describe('administration', () => {
  it('validates postpaid plans: a cap is required and bounded, the threshold within it', async () => {
    for (const body of [
      { billing: 'postpaid' },
      { billing: 'postpaid', postpaidCapMicros: 10_000 * USD + 1 },
      { billing: 'postpaid', postpaidCapMicros: 10 * USD, postpaidThresholdMicros: 11 * USD },
      { billing: 'later' },
    ]) {
      const response = await plansRoute.POST(req('POST', '/x', { name: `P ${JSON.stringify(body)}`, pricePerRequestMicros: 1, ...body }));
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    const created = await plansRoute.POST(req('POST', '/x', { name: 'Metered', pricePerRequestMicros: 1, billing: 'postpaid', postpaidCapMicros: 10 * USD }));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ billing: 'postpaid', postpaidCapMicros: 10 * USD, postpaidThresholdMicros: null });
  });

  it('needs a capped plan for a postpaid consumer; leaving postpaid charges the open amount first', async () => {
    const prepaidPlan = await insertPlan(ctx.db, { name: 'Prepaid only' });
    const refused = await consumersRoute.POST(req('POST', '/x', { name: 'P', planId: prepaidPlan.id, billing: 'postpaid' }));
    expect(refused.status).toBe(400);

    const world = await seed();
    calls(world, 2);
    await flushUsage(T0);
    // A plan's consumers settle first.
    const planSwitch = await planRoute.PUT(req('PUT', '/x', { billing: 'prepaid' }), params(world.planId));
    expect(planSwitch.status).toBe(409);
    // A consumer's open amount is charged as part of the switch; a declined card stops it.
    stripe.paymentIntent = declined('card_declined', 'insufficient_funds');
    const declinedSwitch = await consumerRoute.PUT(req('PUT', '/x', { billing: 'prepaid' }), params(world.consumerId));
    expect(declinedSwitch.status).toBe(409);
    expect((await declinedSwitch.json()).error).toContain('charges the open amount first');
    expect(await consumerRow(world.consumerId)).toMatchObject({ billing: null, balanceMicros: -2 * USD });
    await ctx.db.update(schema.monetizationConsumers).set({ suspendedAt: null, suspendedReason: null }).where(eq(schema.monetizationConsumers.id, world.consumerId));
    await reloadMonetization({ quiet: true });
    stripe.paymentIntent = succeeded();
    const switched = await consumerRoute.PUT(req('PUT', '/x', { billing: 'prepaid' }), params(world.consumerId));
    expect(switched.status).toBe(200);
    expect(await switched.json()).toMatchObject({ billing: 'prepaid', billingOverride: 'prepaid', postpaid: null });
    expect(await consumerRow(world.consumerId)).toMatchObject({ billing: 'prepaid', balanceMicros: 0 });
    expect((await payments(world.consumerId)).filter((row) => row.reason === 'billing_switch').map((row) => row.status)).toEqual(['failed', 'succeeded']);
  });

  it('suspends the consumer while the switch charges, charges the residue, then switches and lifts the suspension', async () => {
    const world = await seed();
    calls(world, 4);
    await flushUsage(T0);
    const during: Array<ReturnType<typeof call>> = [];
    let charges = 0;
    stripe.paymentIntent = (async (entry: { params: URLSearchParams; idempotencyKey: string | null }) => {
      charges += 1;
      // While the charge runs, the gate admits nothing more under the old cap.
      during.push(call(world));
      if (charges === 1) {
        // Usage another node admitted before the suspension reached it, written meanwhile.
        await ctx.db.update(schema.monetizationConsumers).set({ balanceMicros: sql`${schema.monetizationConsumers.balanceMicros} - ${3 * USD}` }).where(eq(schema.monetizationConsumers.id, world.consumerId));
      }
      return succeeded()(entry);
    }) as never;
    const switched = await consumerRoute.PUT(req('PUT', '/x', { billing: 'prepaid' }), params(world.consumerId));
    expect(switched.status).toBe(200);
    expect(during).toEqual([
      expect.objectContaining({ allow: false, status: 402, error: 'payment_overdue', reason: 'billing_switch' }),
      expect.objectContaining({ allow: false, status: 402, error: 'payment_overdue', reason: 'billing_switch' }),
    ]);
    const charged = (await payments(world.consumerId)).filter((row) => row.reason === 'billing_switch');
    expect(charged.map((row) => [row.status, row.amountMicros])).toEqual([['succeeded', 4 * USD], ['succeeded', 3 * USD]]);
    expect(await consumerRow(world.consumerId)).toMatchObject({ billing: 'prepaid', balanceMicros: 0, suspendedAt: null, suspendedReason: null });
    expect(call(world)).toMatchObject({ allow: false, error: 'payment_required' });
  });

  it('answers 402 with a reason and Retry-After while the billing switches, and ends a switch that stopped half way', async () => {
    const world = await seed();
    const stamp = (ms: number) => new Date(ms).toISOString();
    await ctx.db.update(schema.monetizationConsumers).set({ suspendedAt: stamp(T0 - 10 * 60_000), suspendedReason: 'billing_switch' }).where(eq(schema.monetizationConsumers.id, world.consumerId));
    await reloadMonetization({ quiet: true });
    const response = gateResponse(call(world));
    expect(response.status).toBe(402);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(await response.json()).toMatchObject({ error: 'payment_overdue', reason: 'billing_switch', message: expect.stringContaining('being changed') });
    // A fresh one (a switch running) is left alone; one left by a crash is ended.
    const other = await seed();
    await ctx.db.update(schema.monetizationConsumers).set({ suspendedAt: stamp(T0 - 30_000), suspendedReason: 'billing_switch' }).where(eq(schema.monetizationConsumers.id, other.consumerId));
    expect(await clearStaleSwitchSuspensions(T0)).toBe(1);
    expect(await consumerRow(world.consumerId)).toMatchObject({ suspendedAt: null, suspendedReason: null });
    expect(await consumerRow(other.consumerId)).toMatchObject({ suspendedReason: 'billing_switch' });
    expect(call(world)).toMatchObject({ allow: true });
  });

  it('refuses to switch billing while replicas gate with this master\'s shared state', async () => {
    const world = await seed();
    await ctx.db.insert(schema.settings).values([
      { key: 'instance_mode', value: JSON.stringify('master'), updatedAt: new Date(T0).toISOString() },
      { key: 'monetization_options', value: JSON.stringify({ replicas: { mode: 'shared' } }), updatedAt: new Date(T0).toISOString() },
    ]);
    const response = await consumerRoute.PUT(req('PUT', '/x', { billing: 'prepaid' }), params(world.consumerId));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('shared state');
    expect(chargesSent()).toHaveLength(0);
  });

  it('charges now and removes a card without a license; shows the card and the open amount', async () => {
    const world = await seed();
    stripe.paymentIntent = succeeded();
    calls(world, 5);
    await flushUsage(T0);
    await ctx.db.delete(schema.settings).where(eq(schema.settings.key, 'license'));
    const views = await listConsumers();
    expect(views.find((view) => view.id === world.consumerId)).toMatchObject({
      billing: 'postpaid',
      postpaid: { openAmountMicros: 5 * USD, capMicros: 50 * USD, thresholdMicros: 20 * USD, state: 'active', card: { brand: 'visa', last4: '4242', expired: false } },
    });
    const charged = await chargeRoute.POST(req('POST', '/x'), params(world.consumerId));
    expect(charged.status).toBe(200);
    expect(await charged.json()).toMatchObject({ status: 'succeeded', amountMicros: 5 * USD });
    expect((await cardRoute.DELETE(req('DELETE', '/x'), params(world.consumerId))).status).toBe(204);
    expect(stripe.calls.some((entry) => entry.path === '/v1/payment_methods/pm_card1/detach')).toBe(true);
    expect(await consumerRow(world.consumerId)).toMatchObject({ paymentMethodId: null, cardLast4: null });
    expect(call(world)).toMatchObject({ allow: false, error: 'payment_method_required' });
  });
});

describe('a key Stripe refuses', () => {
  it('keeps the charge pending, suspends nobody, tells the operator, and charges once the key works', async () => {
    const world = await seed();
    calls(world, 21);
    await flushUsage(T0);
    stripe.paymentIntent = () => json(401, { error: { type: 'invalid_request_error', code: 'api_key_expired' } });
    expect(await chargeOpenAmount(world.consumerId, 'threshold', { now: T0 })).toMatchObject({ status: 'pending' });
    expect(await consumerRow(world.consumerId)).toMatchObject({ suspendedAt: null });
    expect((await payments(world.consumerId))[0]).toMatchObject({ status: 'pending', failureCode: 'stripe_key_rejected' });
    expect(call(world)).toMatchObject({ allow: true });
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(expect.objectContaining({ action: 'stripe_key_rejected' }));
    const items = await monetizationAttentionProvider.collect({ access: {} as never, now: new Date(T0) });
    expect(items).toEqual([expect.objectContaining({ id: 'stripe-key', severity: 'critical' })]);
    // Stripe accepts the key again: the waiting charge is sent (same idempotency key) and credited; the note goes.
    stripe.paymentIntent = succeeded();
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 30 * 60 * 60_000);
    await ctx.db.update(schema.monetizationPayments).set({ updatedAt: new Date(T0).toISOString() });
    await reconcilePendingCharges(T0 + 30 * 60 * 60_000);
    expect((await payments(world.consumerId))[0]).toMatchObject({ status: 'succeeded', failureCode: null });
    expect(new Set(chargesSent().map((entry) => entry.idempotencyKey)).size).toBe(1);
    expect(await monetizationAttentionProvider.collect({ access: {} as never, now: new Date(T0) })).toEqual([]);
    expect(await consumerRow(world.consumerId)).toMatchObject({ suspendedAt: null, balanceMicros: 0 });
  });
});

describe('the webhook route', () => {
  it('verifies new event types like the others', async () => {
    const world = await seed();
    const body = JSON.stringify({ type: 'charge.dispute.created', data: { object: { id: 'dp_9', payment_intent: 'pi_none', amount: 100, currency: 'usd' } } });
    const sign = (payload: string, secret = WEBHOOK_SECRET) => {
      const t = Math.floor(T0 / 1000);
      return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
    };
    const post = (signature: string) =>
      webhookRoute.POST(new Request('http://localhost/api/monetization/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': signature }, body }));
    expect((await post(sign(body, 'whsec_wrong'))).status).toBe(400);
    const ok = await post(sign(body));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ received: true, ignored: 'payment not recorded here' });
    expect((await consumerRow(world.consumerId)).suspendedAt).toBeNull();
  });
});

describe('the unpaid exposure', () => {
  it('never passes the cap, whatever happens to the charges', async () => {
    const world = await seed({ cap: 10 * USD, threshold: 4 * USD, price: 300_000 });
    const outcomes = [succeeded(), declined('card_declined'), () => { throw new TypeError('fetch failed'); }];
    let now = T0;
    for (let round = 0; round < 40; round++) {
      stripe.paymentIntent = outcomes[round % outcomes.length];
      for (let i = 0; i < 7; i++) call(world, now);
      await flushUsage(now);
      await runPostpaidBilling(now);
      // Charges whose answer was lost are sent again with their key (and meet the outcome of the round).
      await reconcilePendingCharges(now);
      const row = await consumerRow(world.consumerId);
      // What is owed (charges on their way not counted as paid) stays within the cap.
      expect(-row.balanceMicros).toBeLessThanOrEqual(10 * USD);
      if (row.suspendedAt) {
        await ctx.db.update(schema.monetizationConsumers).set({ suspendedAt: null, suspendedReason: null }).where(eq(schema.monetizationConsumers.id, world.consumerId));
        await reloadMonetization({ quiet: true });
      }
      now += 61_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
    }
    expect(chargesSent().length).toBeGreaterThan(3);
  });
});
