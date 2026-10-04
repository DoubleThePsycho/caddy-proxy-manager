/**
 * x402 pay-per-request at the gate (ee/monetization/x402) on Stripe's
 * machine payments and the official x402 SDK, against fakes: the CDP
 * facilitator (GET /supported, POST /verify and /settle under
 * api.cdp.coinbase.com/platform/v2/x402, each call checked for its CDP JWT)
 * and Stripe (the crypto deposit address and the PaymentIntent that records
 * a settled payment). Covers the 402 and its PAYMENT-REQUIRED header as the
 * SDK builds it; a payment verified, settled, recorded and only then
 * forwarded; replays; a wrong amount, receiving address, network, token or
 * resource refused by the SDK before the facilitator is asked; the
 * facilitator refusing or unreachable; Stripe unreachable, still checking,
 * refusing, or not enabled for crypto (a settled payment is never served
 * until Stripe confirms it, and the reconciliation records it with the same
 * idempotency key); the per-address, per-payer and per-second limits; key
 * holders paying with x402; and the settings, the license and the REST API.
 * Nothing calls the real facilitator, Stripe or a blockchain.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, verify as verifySignature } from 'node:crypto';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { installLicense, licenseSigner, setSettingRow } from '../helpers/config-fixture';
import { insertConsumer, insertKey, insertMonetizedHost, insertPlan, insertProxyHost } from '../helpers/monetization';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));
/** The CDP SDK's telemetry switches as they were when @coinbase/x402 (and so @coinbase/cdp-sdk) was loaded. */
const cdpEnvAtLoad = vi.hoisted(() => {
  delete process.env.DISABLE_CDP_USAGE_TRACKING;
  delete process.env.DISABLE_CDP_ERROR_REPORTING;
  return { usage: null as string | null | undefined, errors: null as string | null | undefined };
});

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('@coinbase/x402', async (importOriginal) => {
  cdpEnvAtLoad.usage = process.env.DISABLE_CDP_USAGE_TRACKING;
  cdpEnvAtLoad.errors = process.env.DISABLE_CDP_ERROR_REPORTING;
  return await importOriginal();
});
vi.mock('../../src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-auth')>();
  return { ...actual, requireApiPermission: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }) };
});

import { logAuditEvent } from '../../src/lib/audit';
import { setTrustedLicenseKeysForTests } from '../../ee/licensing/public-keys';
import { reloadMonetization, resetMonetizationEngineForTests } from '../../ee/monetization/engine';
import { handleGateRequest } from '../../ee/monetization/gate-response';
import { monetizationAttentionProvider } from '../../ee/monetization/attention';
import { ensureGateSecret, PAYMENTS_SETTING_KEY } from '../../ee/monetization/settings';
import { NOT_ENABLED_MESSAGE, X402_SETTING_KEY } from '../../ee/monetization/x402/settings';
import { STRIPE_CRYPTO_API_VERSION, stripeKeyFingerprint } from '../../ee/monetization/x402/stripe-crypto';
import {
  reconcileX402Payments,
  resetX402LimitsForTests,
  resetX402ServerForTests,
  X402_ATTEMPTS_PER_ADDRESS_PER_MINUTE,
  X402_PAYER_PER_MINUTE,
  X402_RECORD_ATTEMPTS,
  X402_REFUSED_PAYMENTS_PER_MINUTE,
  X402_STALE_MS,
  X402_VERIFICATION_SHARE_PER_ADDRESS,
  X402_VERIFICATIONS_PER_SECOND,
} from '../../ee/monetization/x402/gate';
import { encryptSecret } from '../../src/lib/secret';
import * as x402Route from '../../app/api/v1/monetization/x402/route';
import * as x402PaymentsRoute from '../../app/api/v1/monetization/x402/payments/route';
import * as hostRoute from '../../app/api/v1/monetization/hosts/[id]/route';
import * as stripeRoute from '../../app/api/v1/monetization/stripe/route';
import { first } from '@/src/lib/db/ops';

const NOW = 1_740_672_100_000;
/** The Stripe deposit address (stored lowercase, as the settings keep it). */
const DEPOSIT = '0x209693bc6afc0c5328ba36faf03c514ef312287c';
/** USDC on Base, the SDK's default asset for eip155:8453. */
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAYER = '0x857b06519E91e3A54538791bDbb0E22373e36b66';
const OTHER = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const TX = `0x${'1234567890abcdef'.repeat(4)}`;
const PI = 'pi_3TestX402Recorded';
/** A live-mode key (x402 needs one); short, so that it never looks like a real one. */
const STRIPE_KEY = 'sk_live_x402TestKeyA1';
const ACCOUNT = 'acct_1TestX402Account';
const RESOURCE = 'https://api.example.com/premium-data';
const CDP = 'https://api.cdp.coinbase.com/platform/v2/x402';
const CDP_KEY_ID = 'organizations/example-org/apiKeys/example-key';

/** A CDP API key secret as CDP issues it: base64 of the Ed25519 seed and public key (64 bytes), made for this run. */
const cdpKey = generateKeyPairSync('ed25519');
const cdpJwk = cdpKey.privateKey.export({ format: 'jwk' }) as { d: string; x: string };
const CDP_SECRET = Buffer.concat([Buffer.from(cdpJwk.d, 'base64url'), Buffer.from(cdpJwk.x, 'base64url')]).toString('base64');

/** What the SDK offers for $0.01: USDC on Base (six decimals), to the deposit address. */
const REQUIREMENTS = {
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '10000',
  asset: USDC_BASE,
  payTo: DEPOSIT,
  maxTimeoutSeconds: 120,
  extra: { name: 'USD Coin', version: '2' },
};

type Call = { service: 'cdp' | 'stripe'; method: string; path: string; headers: Headers; body: any };
type Handler = (body: any, path: string) => Response | Promise<Response>;
const net = vi.hoisted(() => ({
  calls: [] as Array<{ service: 'cdp' | 'stripe'; method: string; path: string; headers: Headers; body: any }>,
  unexpected: [] as string[],
  supported: null as null | ((body: any, path: string) => Response | Promise<Response>),
  verify: null as null | ((body: any, path: string) => Response | Promise<Response>),
  settle: null as null | ((body: any, path: string) => Response | Promise<Response>),
  account: null as null | ((body: any, path: string) => Response | Promise<Response>),
  depositAddress: null as null | ((body: any, path: string) => Response | Promise<Response>),
  createIntent: null as null | ((body: any, path: string) => Response | Promise<Response>),
  readIntent: null as null | ((body: any, path: string) => Response | Promise<Response>),
}));

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function unreachable(): never {
  throw new TypeError('fetch failed');
}
const supportedBase: Handler = () => reply(200, { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }], extensions: [], signers: {} });
const payerOf = (body: any) => body.paymentPayload.payload.authorization.from as string;
const valid: Handler = (body) => reply(200, { isValid: true, payer: payerOf(body) });
/** Each payment's own transaction: TX for the default payment (nonce 1), the nonce's hex for the others. */
const txOf = (body: any) => {
  const nonce = body.paymentPayload.payload.authorization.nonce as string;
  return nonce === `0x${'0'.repeat(63)}1` ? TX : nonce;
};
const settledOk: Handler = (body) => reply(200, { success: true, transaction: txOf(body), network: 'eip155:8453', payer: payerOf(body) });
/** A PaymentIntent answer: `id`, or PI for TX's and one of its own for any other transaction. */
const intent = (status: string, id?: string): Handler => (body) => {
  const tx = body instanceof URLSearchParams ? body.get('payment_method_options[crypto][transaction_verification_options][transaction_hash]') : null;
  const own = !tx || tx === TX ? PI : `pi_3T${tx.slice(-24)}`;
  return reply(200, { id: id ?? own, object: 'payment_intent', status, amount: 1, currency: 'usd' });
};
const depositAddressOk: Handler = () =>
  reply(200, {
    id: 'cda_1TestDepositAddress',
    object: 'crypto.deposit_address',
    livemode: true,
    network: 'base',
    address: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
    supported_tokens: [{ token_currency: 'usdc', token_contract_address: USDC_BASE }],
  });
/** How Stripe answers a payment method the account may not use (the code is assumed: Stripe documents none for crypto). */
const notEnabled: Handler = () =>
  reply(400, { error: { type: 'invalid_request_error', code: 'payment_method_unactivated', message: 'The payment method type "crypto" is not activated for your account.' } });

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  const headers = new Headers(init?.headers);
  if (`${url.origin}${url.pathname}`.startsWith(`${CDP}/`)) {
    const path = url.pathname.slice('/platform/v2/x402/'.length);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    net.calls.push({ service: 'cdp', method, path, headers, body });
    const handler = path === 'supported' ? net.supported : path === 'verify' ? net.verify : path === 'settle' ? net.settle : null;
    if (handler) return await handler(body, path);
  } else if (url.origin === 'https://api.stripe.com') {
    const body = init?.body ? new URLSearchParams(String(init.body)) : null;
    net.calls.push({ service: 'stripe', method, path: url.pathname, headers, body });
    if (method === 'GET' && url.pathname === '/v1/account' && net.account) return await net.account(body, url.pathname);
    if (method === 'POST' && url.pathname === '/v1/crypto/deposit_addresses' && net.depositAddress) return await net.depositAddress(body, url.pathname);
    if (method === 'POST' && url.pathname === '/v1/payment_intents' && net.createIntent) return await net.createIntent(body, url.pathname);
    if (method === 'GET' && url.pathname.startsWith('/v1/payment_intents/') && net.readIntent) return await net.readIntent(body, url.pathname);
  }
  net.unexpected.push(`${method} ${url}`);
  throw new TypeError('fetch failed');
}

const cdpCalls = (path?: string) => net.calls.filter((call) => call.service === 'cdp' && (path === undefined || call.path === path));
const stripeCalls = (path?: string) => net.calls.filter((call) => call.service === 'stripe' && (path === undefined || call.path === path));

/** Checks a CDP call's bearer token: an EdDSA JWT of the key, signed with its secret, for this method and path. */
function expectCdpJwt(call: Call) {
  const authorization = call.headers.get('authorization') ?? '';
  expect(authorization.startsWith('Bearer ')).toBe(true);
  const [header, claims, signature] = authorization.slice(7).split('.');
  expect(verifySignature(null, Buffer.from(`${header}.${claims}`), cdpKey.publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
  expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toMatchObject({ alg: 'EdDSA', kid: CDP_KEY_ID });
  expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toMatchObject({
    sub: CDP_KEY_ID,
    iss: 'cdp',
    uris: [`${call.method} api.cdp.coinbase.com/platform/v2/x402/${call.path}`],
  });
}

async function saveStripe(key: string = STRIPE_KEY) {
  await setSettingRow(ctx.db, PAYMENTS_SETTING_KEY, { secretKey: encryptSecret(key), currency: 'usd', topUpAmountsMicros: [10_000_000] });
}

async function saveX402(values: Record<string, unknown> = {}) {
  await setSettingRow(ctx.db, X402_SETTING_KEY, {
    enabled: true,
    priceCents: 1,
    network: 'eip155:8453',
    cdpKeyId: CDP_KEY_ID,
    cdpKeySecret: encryptSecret(CDP_SECRET),
    depositAddress: { id: 'cda_1TestDepositAddress', address: DEPOSIT, livemode: true, accountId: ACCOUNT, keyFingerprint: stripeKeyFingerprint(STRIPE_KEY) },
    ...values,
  });
}

type World = { token: string; hostId: number };

async function seed(options: { host?: Partial<typeof schema.monetizationHosts.$inferInsert>; x402?: Record<string, unknown> } = {}): Promise<World> {
  const host = await insertProxyHost(ctx.db, { domains: JSON.stringify(['api.example.com']) });
  await insertMonetizedHost(ctx.db, host.id, { x402Enabled: true, ...options.host });
  await saveStripe();
  await saveX402(options.x402);
  const { token } = await ensureGateSecret();
  await reloadMonetization({ quiet: true });
  return { token, hostId: host.id };
}

/** Each test pays from its own client address (the per-address limit counts across tests in a window). */
let testNumber = 0;
let clientIp = '192.0.2.1';

function gateHeaders(world: World, values: Record<string, string> = {}): Headers {
  return new Headers({
    // Set by Caddy on the gate subrequest (the client's own copies are stripped before it).
    'X-Ingressi-Client-Ip': clientIp,
    'X-Ingressi-Gate-Token': world.token,
    'X-Ingressi-Host-Id': String(world.hostId),
    'X-Forwarded-Proto': 'https',
    'X-Forwarded-Host': 'api.example.com',
    'X-Forwarded-Uri': '/premium-data',
    ...values,
  });
}

type PaymentOptions = { accepted?: Record<string, unknown>; authorization?: Record<string, string>; resource?: unknown; x402Version?: number };

/** A client's payment for REQUIREMENTS with its own nonce; the signature is opaque here (the fake facilitator verifies). */
function payment(nonce: number = 1, options: PaymentOptions = {}) {
  return {
    x402Version: options.x402Version ?? 2,
    resource: options.resource === undefined ? { url: RESOURCE } : options.resource,
    accepted: { ...REQUIREMENTS, ...options.accepted },
    payload: {
      signature: `0x${'5a'.repeat(65)}`,
      authorization: {
        from: PAYER,
        to: DEPOSIT,
        value: '10000',
        validAfter: String(NOW / 1000 - 60),
        validBefore: String(NOW / 1000 + 120),
        nonce: `0x${nonce.toString(16).padStart(64, '0')}`,
        ...options.authorization,
      },
    },
  };
}

function withPayment(world: World, body: unknown = payment(), extra: Record<string, string> = {}): Headers {
  return gateHeaders(world, { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(body as never), ...extra });
}

const requiredOf = (response: Response) => decodePaymentRequiredHeader(response.headers.get('payment-required')!);
const errorOf = (response: Response) => requiredOf(response).error;

async function payments() {
  return await ctx.db.select().from(schema.monetizationX402Payments).orderBy(schema.monetizationX402Payments.id);
}

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/v1/monetization/x402', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** The monetization items of Needs attention. */
const attention = () => monetizationAttentionProvider.collect({ access: {} as never, now: new Date(NOW) });

/** Real time (Date.now is pinned to NOW; the rows' timestamps are not). */
const wallClock = () => new Date().getTime();

beforeEach(async () => {
  testNumber += 1;
  clientIp = `198.51.100.${testNumber}`;
  ctx.db = createTestDb();
  resetMonetizationEngineForTests();
  resetX402ServerForTests();
  await resetX402LimitsForTests();
  net.calls = [];
  net.unexpected = [];
  net.supported = supportedBase;
  net.verify = valid;
  net.settle = settledOk;
  net.account = () => reply(200, { id: ACCOUNT, object: 'account' });
  net.depositAddress = depositAddressOk;
  net.createIntent = intent('succeeded');
  net.readIntent = intent('succeeded');
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.mocked(logAuditEvent).mockClear();
  setTrustedLicenseKeysForTests(licenseSigner.keys);
  await installLicense(ctx.db, 'enterprise');
});

afterEach(() => {
  expect(net.unexpected).toEqual([]);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => setTrustedLicenseKeysForTests(null));

describe('the offer', () => {
  it('answers a request without a key with 402 and the SDK\'s PAYMENT-REQUIRED: USDC on Base, $0.01, to the Stripe deposit address', async () => {
    const world = await seed();
    const response = await handleGateRequest(gateHeaders(world), NOW);
    expect(response.status).toBe(402);
    expect(requiredOf(response)).toEqual({ x402Version: 2, resource: { url: RESOURCE }, accepts: [REQUIREMENTS] });
    expect(response.headers.get('access-control-expose-headers')).toBe('PAYMENT-REQUIRED, PAYMENT-RESPONSE');
    expect(response.headers.get('link')).toMatch(/rel="payment"/);
    expect(response.headers.get('www-authenticate')).toBe('Bearer realm="api"');
    expect(await response.json()).toMatchObject({
      error: 'payment_required',
      topUpUrl: expect.stringContaining('/api-portal'),
      x402: { x402Version: 2, accepts: [{ network: 'eip155:8453', networkLabel: 'Base', token: 'USDC', amount: '10000', price: '$0.01' }] },
    });
    // The facilitator's capabilities, asked once with the CDP key's token; nothing verified, nothing recorded.
    expect(cdpCalls().map((call) => `${call.method} ${call.path}`)).toEqual(['GET supported']);
    expectCdpJwt(cdpCalls()[0] as Call);
    await handleGateRequest(gateHeaders(world), NOW);
    expect(cdpCalls()).toHaveLength(1);
    expect(stripeCalls()).toHaveLength(0);
  });

  it('asks a host\'s own price', async () => {
    const world = await seed({ host: { x402PriceCents: 25 } });
    const response = await handleGateRequest(gateHeaders(world), NOW);
    expect(requiredOf(response).accepts[0]).toMatchObject({ amount: '250000', payTo: DEPOSIT });
    expect((await response.json()).x402.accepts[0].price).toBe('$0.25');
  });

  it('is not made with x402 off or not set up, on a host without it, for a wrong key or without the gate token', async () => {
    const off = await seed({ x402: { enabled: false } });
    expect((await handleGateRequest(gateHeaders(off), NOW)).status).toBe(401);
    const noAddress = await seed({ x402: { depositAddress: null } });
    expect((await handleGateRequest(gateHeaders(noAddress), NOW)).status).toBe(401);
    const plain = await seed({ host: { x402Enabled: false } });
    expect((await handleGateRequest(gateHeaders(plain), NOW)).status).toBe(401);
    // A payment sent to a host without x402 gets the plain denial, not "try again".
    expect((await handleGateRequest(withPayment(plain), NOW)).status).toBe(401);
    const host = await seed();
    expect((await handleGateRequest(gateHeaders(host, { Authorization: 'Bearer ik_000000000000_bad' }), NOW)).status).toBe(401);
    expect((await handleGateRequest(gateHeaders(host, { 'X-Ingressi-Gate-Token': 'forged' }), NOW)).status).toBe(403);
    expect(cdpCalls('verify')).toHaveLength(0);
  });

  it('offers nothing and lets nothing through while the facilitator cannot be reached, and asks again after 30 seconds', async () => {
    const world = await seed();
    net.supported = unreachable;
    expect((await handleGateRequest(gateHeaders(world), NOW)).status).toBe(401);
    const paid = await handleGateRequest(withPayment(world), NOW + 1_000);
    expect(paid.status).toBe(503);
    expect(await paid.json()).toMatchObject({ error: 'x402_unavailable' });
    expect(cdpCalls('supported')).toHaveLength(1);
    net.supported = supportedBase;
    expect((await handleGateRequest(gateHeaders(world), NOW + 29_000)).status).toBe(401);
    expect((await handleGateRequest(gateHeaders(world), NOW + 31_000)).status).toBe(402);
    expect(cdpCalls('supported')).toHaveLength(2);
    expect(await payments()).toHaveLength(0);
  });

  it('offers nothing when the facilitator does not support exact payments on Base', async () => {
    const world = await seed();
    net.supported = () => reply(200, { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }], extensions: [], signers: {} });
    expect((await handleGateRequest(gateHeaders(world), NOW)).status).toBe(401);
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(503);
    expect(cdpCalls('verify')).toHaveLength(0);
  });

  it('asks version 1 clients for version 2', async () => {
    const world = await seed();
    const response = await handleGateRequest(gateHeaders(world, { 'X-PAYMENT': 'e30=' }), NOW);
    expect(response.status).toBe(402);
    expect(errorOf(response)).toBe('invalid_x402_version');
  });
});

describe('paying', () => {
  it('verifies and settles through the CDP facilitator, records the payment with Stripe, and only then forwards', async () => {
    const world = await seed();
    const response = await handleGateRequest(withPayment(world), NOW);
    expect(response.status).toBe(200);
    expect(decodePaymentResponseHeader(response.headers.get('payment-response')!)).toEqual({ success: true, transaction: TX, network: 'eip155:8453', payer: PAYER });
    expect(response.headers.get('x-ingressi-consumer-id')).toBeNull();

    expect(net.calls.map((call) => `${call.service} ${call.method} ${call.path}`)).toEqual([
      'cdp GET supported',
      'cdp POST verify',
      'cdp POST settle',
      'stripe POST /v1/payment_intents',
    ]);
    for (const call of cdpCalls().slice(1)) {
      expect(call.body).toEqual({ x402Version: 2, paymentPayload: payment(), paymentRequirements: REQUIREMENTS });
      expectCdpJwt(call as Call);
    }
    const [record] = stripeCalls();
    expect(record.headers.get('authorization')).toBe(`Bearer ${STRIPE_KEY}`);
    expect(record.headers.get('stripe-version')).toBe(STRIPE_CRYPTO_API_VERSION);
    expect(STRIPE_CRYPTO_API_VERSION).toBe('2026-05-27.preview');
    expect(record.headers.get('idempotency-key')).toBe(TX);
    const params = Object.fromEntries(record.body as URLSearchParams);
    expect(params).toMatchObject({
      amount: '1',
      currency: 'usd',
      confirm: 'true',
      'payment_method_data[type]': 'crypto',
      'allowed_payment_method_types[]': 'crypto',
      'payment_method_options[crypto][mode]': 'transaction_verification',
      'payment_method_options[crypto][transaction_verification_options][network]': 'base',
      'payment_method_options[crypto][transaction_verification_options][transaction_hash]': TX,
      'metadata[ingressi_kind]': 'x402',
    });

    const [row] = await payments();
    expect(row).toMatchObject({
      status: 'settled',
      transaction: TX,
      paymentIntentId: PI,
      payer: PAYER.toLowerCase(),
      network: 'eip155:8453',
      asset: USDC_BASE,
      amountMicros: 10_000,
      consumerId: null,
      errorReason: null,
    });
    expect(JSON.stringify(row)).not.toContain('5a5a5a');
  });

  it('accepts a payload once: a replay is refused on its nonce, without asking the facilitator or Stripe again', async () => {
    const world = await seed();
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(200);
    const replay = await handleGateRequest(withPayment(world), NOW);
    expect(replay.status).toBe(402);
    expect(errorOf(replay)).toBe('payment_already_used');
    expect(cdpCalls('verify')).toHaveLength(1);
    expect(cdpCalls('settle')).toHaveLength(1);
    expect(stripeCalls()).toHaveLength(1);
    // The same payment on another host is used too.
    const other = await seed();
    expect(errorOf(await handleGateRequest(withPayment(other), NOW))).toBe('payment_already_used');
  });

  it('refuses a wrong amount, receiving address, network, token, scheme or terms: the SDK matches nothing, nothing is asked or kept', async () => {
    const world = await seed();
    const cases: Array<Record<string, unknown>> = [
      { amount: '1' },
      { amount: '9999' },
      { payTo: OTHER },
      { network: 'eip155:84532' },
      { network: 'eip155:1' },
      { asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
      { scheme: 'upto' },
      { maxTimeoutSeconds: 3_600 },
      { extra: { name: 'USDC', version: '2' } },
    ];
    for (const accepted of cases) {
      const response = await handleGateRequest(withPayment(world, payment(1, { accepted })), NOW);
      expect(response.status, JSON.stringify(accepted)).toBe(402);
      expect(errorOf(response), JSON.stringify(accepted)).toBe('invalid_payment_requirements');
    }
    expect(cdpCalls('verify')).toHaveLength(0);
    expect(await payments()).toHaveLength(0);
  });

  it('refuses another resource, version 1 payloads and malformed payloads before the facilitator is asked', async () => {
    const world = await seed();
    const cases: Array<[Headers, string]> = [
      [withPayment(world, payment(1, { resource: { url: 'https://api.example.com/other' } })), 'invalid_resource'],
      [withPayment(world, payment(1, { x402Version: 1 })), 'invalid_x402_version'],
      [gateHeaders(world, { 'PAYMENT-SIGNATURE': 'not a payment!' }), 'invalid_payload'],
      [gateHeaders(world, { 'PAYMENT-SIGNATURE': Buffer.from('null').toString('base64') }), 'invalid_payload'],
      [gateHeaders(world, { 'PAYMENT-SIGNATURE': Buffer.from('[1,2]').toString('base64') }), 'invalid_payload'],
      [withPayment(world, { ...payment(), payload: null }), 'invalid_payload'],
      [withPayment(world, { ...payment(), payload: { signature: '0x00' } }), 'invalid_payload'],
      [withPayment(world, payment(1, { authorization: { from: 'not-an-address' } })), 'invalid_payload'],
      [gateHeaders(world, { 'PAYMENT-SIGNATURE': 'A'.repeat(9_000) }), 'invalid_payload'],
    ];
    for (const [headers, reason] of cases) {
      const response = await handleGateRequest(headers, NOW);
      expect(response.status, reason).toBe(402);
      expect(errorOf(response), reason).toBe(reason);
    }
    expect(cdpCalls('verify')).toHaveLength(0);
    expect(await payments()).toHaveLength(0);
  });

  it('keeps nothing of a payment the facilitator finds invalid, answers its reason, and takes the same payload once it is valid', async () => {
    const world = await seed();
    net.verify = () => reply(200, { isValid: false, invalidReason: 'insufficient_funds', payer: PAYER });
    expect(errorOf(await handleGateRequest(withPayment(world), NOW))).toBe('insufficient_funds');
    // The SDK's VerifyError (an HTTP error carrying a verification) is a refusal too.
    net.verify = () => reply(400, { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature', payer: PAYER });
    expect(errorOf(await handleGateRequest(withPayment(world), NOW))).toBe('invalid_exact_evm_payload_signature');
    expect(await payments()).toHaveLength(0);
    expect(cdpCalls('settle')).toHaveLength(0);
    net.verify = valid;
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(200);
  });

  it('treats a verification of another payer as invalid', async () => {
    const world = await seed();
    net.verify = () => reply(200, { isValid: true, payer: OTHER });
    expect(errorOf(await handleGateRequest(withPayment(world), NOW))).toBe('payer_mismatch');
    expect(cdpCalls('settle')).toHaveLength(0);
    expect(await payments()).toHaveLength(0);
  });

  it('answers 503 when verification cannot be had (unreachable, an outage, a reply that is not one), keeps nothing, and takes the payload later', async () => {
    const world = await seed();
    for (const handler of [unreachable, () => reply(502, { message: 'bad gateway' }), () => new Response('<html>', { status: 200 })]) {
      net.verify = handler as Handler;
      const response = await handleGateRequest(withPayment(world), NOW);
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('5');
    }
    expect(await payments()).toHaveLength(0);
    net.verify = valid;
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(200);
  });

  it('does not forward when settlement fails, and says why in PAYMENT-RESPONSE; Stripe is not asked', async () => {
    const world = await seed();
    net.settle = () => reply(200, { success: false, errorReason: 'insufficient_funds', transaction: '', network: 'eip155:8453', payer: PAYER });
    const response = await handleGateRequest(withPayment(world), NOW);
    expect(response.status).toBe(402);
    expect(errorOf(response)).toBe('insufficient_funds');
    expect(decodePaymentResponseHeader(response.headers.get('payment-response')!)).toMatchObject({ success: false, errorReason: 'insufficient_funds', transaction: '' });
    expect((await payments())[0]).toMatchObject({ status: 'failed', errorReason: 'insufficient_funds', transaction: null });
    expect(stripeCalls()).toHaveLength(0);
  });

  it('keeps a settlement whose outcome is not known for the operator, never forwards it, and does not settle it again', async () => {
    const world = await seed();
    net.settle = unreachable;
    const response = await handleGateRequest(withPayment(world), NOW);
    expect(response.status).toBe(503);
    expect(response.headers.get('payment-required')).toBeNull();
    expect((await payments())[0]).toMatchObject({ status: 'unknown', errorReason: 'settle_unavailable' });
    net.settle = settledOk;
    const again = await handleGateRequest(withPayment(world), NOW);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'payment_not_recorded' });
    expect(cdpCalls('settle')).toHaveLength(1);
    expect(stripeCalls()).toHaveLength(0);
  });

  it('keeps a transaction still pending after the SDK\'s one retry, with its hash, never forwarded', async () => {
    const world = await seed();
    net.settle = () => reply(200, { success: false, errorReason: 'settlement_pending', transaction: TX, network: 'eip155:8453', payer: PAYER });
    const response = await handleGateRequest(withPayment(world), NOW);
    expect(response.status).toBe(503);
    expect(cdpCalls('settle')).toHaveLength(2);
    expect((await payments())[0]).toMatchObject({ status: 'unknown', transaction: TX, errorReason: 'settlement_pending' });
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(409);
    expect(stripeCalls()).toHaveLength(0);
  });
});

describe('recording with Stripe', () => {
  it('never forwards a settled payment while Stripe cannot be reached; the client\'s retry records it with the same idempotency key and is served once', async () => {
    const world = await seed();
    for (const handler of [unreachable, () => reply(500, { error: { type: 'api_error' } }), () => reply(429, { error: { type: 'rate_limit_error' } })]) {
      net.createIntent = handler as Handler;
      const response = await handleGateRequest(withPayment(world), NOW);
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('10');
      expect((await response.json()).message).toContain('not taken twice');
      expect(response.headers.get('payment-response')).toBeNull();
      expect((await payments())[0]).toMatchObject({ status: 'recording', transaction: TX, paymentIntentId: null });
    }
    // Settled once, whatever happened after.
    expect(cdpCalls('settle')).toHaveLength(1);
    net.createIntent = intent('succeeded');
    const served = await handleGateRequest(withPayment(world), NOW);
    expect(served.status).toBe(200);
    expect(decodePaymentResponseHeader(served.headers.get('payment-response')!)).toMatchObject({ success: true, transaction: TX });
    const records = stripeCalls('/v1/payment_intents');
    expect(records).toHaveLength(4);
    expect(new Set(records.map((call) => call.headers.get('idempotency-key')))).toEqual(new Set([TX]));
    expect((await payments())[0]).toMatchObject({ status: 'settled', paymentIntentId: PI });
    expect(errorOf(await handleGateRequest(withPayment(world), NOW))).toBe('payment_already_used');
    expect(cdpCalls('settle')).toHaveLength(1);
  });

  it('records what Stripe could not take in the reconciliation, with the same idempotency key; the payload is then served once', async () => {
    const world = await seed();
    net.createIntent = unreachable;
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(503);
    expect((await attention()).map((item) => item.id)).toContain('x402-unrecorded');
    // Too recent: left for the client's own retry.
    expect(await reconcileX402Payments(wallClock())).toMatchObject({ recorded: 0 });
    expect(stripeCalls()).toHaveLength(1);
    net.createIntent = intent('succeeded');
    expect(await reconcileX402Payments(wallClock() + 31_000)).toEqual({ released: 0, interrupted: 0, recorded: 1 });
    expect(stripeCalls('/v1/payment_intents').map((call) => call.headers.get('idempotency-key'))).toEqual([TX, TX]);
    expect((await payments())[0]).toMatchObject({ status: 'confirmed', paymentIntentId: PI });
    expect(await attention()).toEqual([]);
    // Confirmed, not yet served: the same payload is served, once.
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(200);
    expect(errorOf(await handleGateRequest(withPayment(world), NOW))).toBe('payment_already_used');
    expect(cdpCalls('settle')).toHaveLength(1);
    expect(stripeCalls()).toHaveLength(2);
  });

  it('waits for a PaymentIntent Stripe is still checking, and looks at it again', async () => {
    const world = await seed();
    net.createIntent = intent('processing');
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(503);
    expect((await payments())[0]).toMatchObject({ status: 'recording', paymentIntentId: PI });
    net.readIntent = intent('succeeded');
    expect(await reconcileX402Payments(wallClock() + 31_000)).toMatchObject({ recorded: 1 });
    expect(stripeCalls().map((call) => `${call.method} ${call.path}`)).toEqual(['POST /v1/payment_intents', `GET /v1/payment_intents/${PI}`]);
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(200);
  });

  it('asks again after a refusal, a minute and ten minutes later with new idempotency keys, then keeps it for the operator, never forwarded', async () => {
    const world = await seed();
    net.createIntent = () =>
      reply(402, {
        error: {
          type: 'invalid_request_error',
          code: 'payment_intent_payment_attempt_failed',
          message: 'The transaction could not be verified.',
          payment_intent: { id: 'pi_3TestX402Refused', status: 'requires_payment_method' },
        },
      });
    const response = await handleGateRequest(withPayment(world), NOW);
    // Not final yet: the client is told to come back, not to contact anyone.
    expect(response.status).toBe(503);
    expect((await payments())[0]).toMatchObject({ status: 'recording', recordAttempts: 1, paymentIntentId: null, errorReason: 'payment_intent_payment_attempt_failed', transaction: TX });
    // The client's retry before the minute is up asks Stripe nothing.
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(503);
    expect(await reconcileX402Payments(wallClock() + 31_000)).toMatchObject({ recorded: 0 });
    expect(stripeCalls()).toHaveLength(1);
    // A minute on: the second attempt, with its own idempotency key.
    await reconcileX402Payments(wallClock() + 61_000);
    expect((await payments())[0]).toMatchObject({ status: 'recording', recordAttempts: 2 });
    await reconcileX402Payments(wallClock() + 5 * 60_000);
    expect(stripeCalls()).toHaveLength(2);
    // Ten minutes on: the third and last.
    await reconcileX402Payments(wallClock() + 11 * 60_000);
    expect(stripeCalls().map((call) => call.headers.get('idempotency-key'))).toEqual([TX, `${TX}:2`, `${TX}:3`]);
    expect(X402_RECORD_ATTEMPTS).toBe(3);
    expect((await payments())[0]).toMatchObject({ status: 'unrecorded', recordAttempts: 3, paymentIntentId: 'pi_3TestX402Refused', errorReason: 'payment_intent_payment_attempt_failed', transaction: TX });
    const final = await handleGateRequest(withPayment(world), NOW);
    expect(final.status).toBe(409);
    expect(await final.json()).toMatchObject({ error: 'payment_not_recorded', message: expect.stringContaining('operator') });
    const [item] = await attention();
    expect(item).toMatchObject({ id: 'x402-unrecorded', title: '1 x402 payment not recorded by Stripe' });
    await reconcileX402Payments(wallClock() + 60 * 60_000);
    expect(stripeCalls()).toHaveLength(3);
  });

  it('serves a payment Stripe refused once and then recorded', async () => {
    const world = await seed();
    net.createIntent = intent('requires_payment_method', 'pi_3TestX402Failed');
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(503);
    expect((await payments())[0]).toMatchObject({ status: 'recording', recordAttempts: 1, paymentIntentId: null, errorReason: 'requires_payment_method' });
    net.createIntent = intent('succeeded');
    expect(await reconcileX402Payments(wallClock() + 61_000)).toMatchObject({ recorded: 1 });
    expect(stripeCalls().map((call) => call.headers.get('idempotency-key'))).toEqual([TX, `${TX}:2`]);
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(200);
    expect((await payments())[0]).toMatchObject({ status: 'settled', paymentIntentId: PI });
  });

  it('says when Stripe has not enabled crypto, keeps the settled payment, and records it once Stripe does', async () => {
    const world = await seed();
    net.createIntent = notEnabled;
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(503);
    expect((await payments())[0]).toMatchObject({ status: 'recording', errorReason: 'stripe_not_enabled' });
    const view = await (await x402Route.GET(req('GET'))).json();
    expect(view.notEnabledMessage).toBe(NOT_ENABLED_MESSAGE);
    expect(NOT_ENABLED_MESSAGE).toContain('machine-payments@stripe.com');
    const [item] = await attention();
    expect(item.detail).toContain('Stablecoins and Crypto');
    // Not recognised by its code: a refusal whose message says crypto is not enabled.
    net.createIntent = () => reply(400, { error: { type: 'invalid_request_error', message: 'Crypto payments are not enabled for this account. Request access in the Dashboard.' } });
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(503);
    expect((await payments())[0]).toMatchObject({ status: 'recording', errorReason: 'stripe_not_enabled' });
    net.createIntent = intent('succeeded');
    expect(await reconcileX402Payments(wallClock() + 31_000)).toMatchObject({ recorded: 1 });
    expect((await (await x402Route.GET(req('GET'))).json()).notEnabledMessage).toBeNull();
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(200);
  });

  it('stops a reconciliation pass at the first payment Stripe cannot take', async () => {
    const world = await seed();
    net.createIntent = unreachable;
    for (let i = 1; i <= 3; i++) {
      clientIp = `203.0.113.${i}`;
      expect((await handleGateRequest(withPayment(world, payment(i)), NOW)).status).toBe(503);
    }
    expect(await payments()).toHaveLength(3);
    await reconcileX402Payments(wallClock() + 31_000);
    expect(stripeCalls()).toHaveLength(4);
  });

  it('releases a nonce claimed but never verified, and keeps a settlement cut short by a crash as unknown', async () => {
    const world = await seed();
    const old = new Date(wallClock() - X402_STALE_MS - 60_000).toISOString();
    const fresh = new Date().toISOString();
    const row = { proxyHostId: world.hostId, payer: PAYER.toLowerCase(), network: 'eip155:8453', asset: USDC_BASE, amountMicros: 10_000, createdAt: old, updatedAt: old };
    await ctx.db.insert(schema.monetizationX402Payments).values([
      { ...row, nonceKey: 'a'.repeat(64), status: 'verifying' },
      { ...row, nonceKey: 'b'.repeat(64), status: 'settling' },
      { ...row, nonceKey: 'c'.repeat(64), status: 'settling', createdAt: fresh, updatedAt: fresh },
    ]);
    expect(await reconcileX402Payments(wallClock())).toEqual({ released: 1, interrupted: 1, recorded: 0 });
    expect((await payments()).map((payment) => [payment.nonceKey[0], payment.status, payment.errorReason])).toEqual([
      ['b', 'unknown', 'settle_interrupted'],
      ['c', 'settling', null],
    ]);
  });
});

describe('limits', () => {
  it('limits payment attempts per client address, whatever they carry', async () => {
    const world = await seed();
    const junk = gateHeaders(world, { 'PAYMENT-SIGNATURE': 'not-a-payment' });
    for (let i = 0; i < X402_ATTEMPTS_PER_ADDRESS_PER_MINUTE; i++) expect((await handleGateRequest(junk, NOW)).status).toBe(402);
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(429);
    expect(cdpCalls('verify')).toHaveLength(0);
    clientIp = '203.0.113.7';
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(200);
  });

  it('keys the per-address limit on the address Caddy set, an IPv6 /48 as one, never on headers the client sends', async () => {
    const world = await seed();
    const previous = process.env.TRUSTED_CLIENT_IP_HEADER;
    process.env.TRUSTED_CLIENT_IP_HEADER = 'x-real-ip';
    try {
      const junk = (ip: string, i: number) =>
        gateHeaders(world, { 'X-Ingressi-Client-Ip': ip, 'X-Real-IP': `198.51.100.${i % 250}`, 'X-Forwarded-For': `192.0.2.${i % 250}`, 'PAYMENT-SIGNATURE': 'not-a-payment' });
      for (let i = 0; i < X402_ATTEMPTS_PER_ADDRESS_PER_MINUTE; i++) {
        expect((await handleGateRequest(junk(`2001:db8:aa:${(i % 9000).toString(16)}::${i.toString(16)}`, i), NOW)).status).toBe(402);
      }
      expect((await handleGateRequest(junk('2001:db8:aa:ffff::1', 0), NOW)).status).toBe(429);
      expect((await handleGateRequest(junk('2001:db8:bb::1', 0), NOW)).status).toBe(402);
    } finally {
      if (previous === undefined) delete process.env.TRUSTED_CLIENT_IP_HEADER;
      else process.env.TRUSTED_CLIENT_IP_HEADER = previous;
    }
  });

  it('refuses an address whose payments the facilitator keeps refusing, before it costs another call', async () => {
    const world = await seed();
    net.verify = () => reply(200, { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature', payer: PAYER });
    for (let i = 0; i < X402_REFUSED_PAYMENTS_PER_MINUTE; i++) expect((await handleGateRequest(withPayment(world, payment(100 + i)), NOW)).status).toBe(402);
    expect((await handleGateRequest(withPayment(world, payment(200)), NOW)).status).toBe(429);
    expect(cdpCalls('verify')).toHaveLength(X402_REFUSED_PAYMENTS_PER_MINUTE);
    net.verify = valid;
    clientIp = '203.0.113.8';
    expect((await handleGateRequest(withPayment(world, payment(201)), NOW)).status).toBe(200);
  });

  it('limits paid requests per payer and minute, from any address', async () => {
    const world = await seed();
    const statuses: number[] = [];
    for (let i = 0; i <= X402_PAYER_PER_MINUTE; i++) {
      clientIp = `2001:db8:${(0x5000 + i).toString(16)}::1`;
      statuses.push((await handleGateRequest(withPayment(world, payment(1_000 + i)), NOW)).status);
    }
    expect(statuses.filter((status) => status === 200)).toHaveLength(X402_PAYER_PER_MINUTE);
    expect(statuses.at(-1)).toBe(429);
    // Counted once verified: the last one was verified, then refused before settling; its nonce is free again.
    expect(cdpCalls('verify')).toHaveLength(X402_PAYER_PER_MINUTE + 1);
    expect(cdpCalls('settle')).toHaveLength(X402_PAYER_PER_MINUTE);
    expect(await payments()).toHaveLength(X402_PAYER_PER_MINUTE);
  });

  it('never lets payloads that only claim a payer use up that payer\'s limit', async () => {
    const world = await seed();
    // Someone else's payloads naming PAYER, which the facilitator refuses, from many addresses.
    net.verify = () => reply(200, { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' });
    for (let i = 0; i <= X402_PAYER_PER_MINUTE + 5; i++) {
      clientIp = `2001:db8:${(0x6000 + i).toString(16)}::1`;
      expect((await handleGateRequest(withPayment(world, payment(2_000 + i)), NOW)).status).toBe(402);
    }
    // The real payer still pays.
    net.verify = valid;
    clientIp = '2001:db8:7000::1';
    expect((await handleGateRequest(withPayment(world, payment(3_000)), NOW)).status).toBe(200);
  });

  it('gives one address at most its share of the facilitator checks of a second', async () => {
    const world = await seed();
    clientIp = '2001:db8:4000::1';
    const statuses: number[] = [];
    for (let i = 0; i < X402_VERIFICATION_SHARE_PER_ADDRESS; i++) statuses.push((await handleGateRequest(withPayment(world, payment(300 + i)), NOW)).status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(X402_VERIFICATION_SHARE_PER_ADDRESS);
    const shed = await handleGateRequest(withPayment(world, payment(400)), NOW);
    expect(shed.status).toBe(503);
    expect(shed.headers.get('retry-after')).toBe('1');
    // Another address in the same second, and this one the next second: served.
    clientIp = '2001:db8:4001::1';
    expect((await handleGateRequest(withPayment(world, payment(401)), NOW)).status).toBe(200);
    clientIp = '2001:db8:4000::1';
    expect((await handleGateRequest(withPayment(world, payment(402)), NOW + 1_000)).status).toBe(200);
  });

  it('caps facilitator checks per process and second, whatever addresses the attempts come from', async () => {
    const world = await seed();
    net.verify = () => reply(200, { isValid: false, invalidReason: 'insufficient_funds', payer: PAYER });
    for (let i = 0; i < X402_VERIFICATIONS_PER_SECOND; i++) {
      // Each from its own /48 and payer: only the per-process cap applies.
      clientIp = `2001:db8:${(0x1000 + i).toString(16)}::1`;
      const from = `0x${(0xa000 + i).toString(16).padStart(40, '0')}`;
      expect((await handleGateRequest(withPayment(world, payment(500 + i, { authorization: { from } })), NOW)).status).toBe(402);
    }
    net.verify = valid;
    clientIp = '2001:db8:ffff::1';
    const shed = await handleGateRequest(withPayment(world, payment(900)), NOW);
    expect(shed.status).toBe(503);
    expect(shed.headers.get('retry-after')).toBe('1');
    expect(await payments()).toHaveLength(0);
    expect((await handleGateRequest(withPayment(world, payment(900)), NOW + 1_000)).status).toBe(200);
  });
});

describe('key holders on a plan that accepts x402', () => {
  it('get the x402 offer when the balance runs out, and pay without touching it', async () => {
    const plan = await insertPlan(ctx.db, { pricePerRequestMicros: 5_000, acceptX402: true });
    const consumer = await insertConsumer(ctx.db, { planId: plan.id, balanceMicros: 0 });
    const { raw } = await insertKey(ctx.db, consumer.id);
    const world = await seed();
    const headers = (values: Record<string, string> = {}) => gateHeaders(world, { Authorization: `Bearer ${raw}`, ...values });
    const offered = await handleGateRequest(headers(), NOW);
    expect(offered.status).toBe(402);
    expect(requiredOf(offered).accepts).toEqual([REQUIREMENTS]);
    expect(await offered.json()).toMatchObject({ error: 'payment_required', balanceMicros: 0, priceMicros: 5_000 });
    const paid = await handleGateRequest(headers({ 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(payment() as never) }), NOW);
    expect(paid.status).toBe(200);
    expect(paid.headers.get('x-ingressi-consumer-id')).toBe(String(consumer.id));
    expect((await payments())[0]).toMatchObject({ consumerId: consumer.id, status: 'settled' });
    expect((await first(ctx.db.select().from(schema.monetizationConsumers).where(eq(schema.monetizationConsumers.id, consumer.id)).limit(1)))!.balanceMicros).toBe(0);
  });

  it('get no offer on a plan that does not accept x402', async () => {
    const plan = await insertPlan(ctx.db, { pricePerRequestMicros: 5_000, acceptX402: false });
    const consumer = await insertConsumer(ctx.db, { planId: plan.id, balanceMicros: 0 });
    const { raw } = await insertKey(ctx.db, consumer.id);
    const world = await seed();
    const response = await handleGateRequest(gateHeaders(world, { Authorization: `Bearer ${raw}` }), NOW);
    expect(response.status).toBe(402);
    expect(response.headers.get('payment-required')).toBeNull();
  });
});

describe('one transaction, one payment', () => {
  it('refuses a second payment backed by a transaction that already backs one', async () => {
    const world = await seed();
    net.settle = (body) => reply(200, { success: true, transaction: TX, network: 'eip155:8453', payer: payerOf(body) });
    expect((await handleGateRequest(withPayment(world, payment(1)), NOW)).status).toBe(200);
    // The facilitator answers the second payment with the first one's transaction.
    const second = await handleGateRequest(withPayment(world, payment(2)), NOW);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: 'payment_not_recorded' });
    expect((await payments())[1]).toMatchObject({ status: 'unrecorded', errorReason: 'duplicate_transaction', transaction: null });
    expect(stripeCalls()).toHaveLength(1);
  });

  it('refuses a PaymentIntent that already records another payment', async () => {
    const world = await seed();
    const TX2 = `0x${'fedcba0987654321'.repeat(4)}`;
    net.settle = (body) => reply(200, { success: true, transaction: cdpCalls('settle').length > 1 ? TX2 : TX, network: 'eip155:8453', payer: payerOf(body) });
    net.createIntent = intent('succeeded', PI);
    expect((await handleGateRequest(withPayment(world, payment(1)), NOW)).status).toBe(200);
    // Stripe answers the second transaction with the first one's PaymentIntent.
    expect((await handleGateRequest(withPayment(world, payment(2)), NOW)).status).toBe(409);
    expect((await payments())[1]).toMatchObject({ status: 'unrecorded', errorReason: 'duplicate_payment_intent', transaction: TX2, paymentIntentId: null });
  });

  it('does not record a settlement for another network or payer than the one verified', async () => {
    const world = await seed();
    net.settle = (body) => reply(200, { success: true, transaction: TX, network: 'eip155:84532', payer: payerOf(body) });
    expect((await handleGateRequest(withPayment(world, payment(1)), NOW)).status).toBe(409);
    const TX2 = `0x${'fedcba0987654321'.repeat(4)}`;
    net.settle = () => reply(200, { success: true, transaction: TX2, network: 'eip155:8453', payer: OTHER });
    expect((await handleGateRequest(withPayment(world, payment(2)), NOW)).status).toBe(409);
    expect((await payments()).map((row) => [row.status, row.errorReason, row.transaction])).toEqual([
      ['unknown', 'settlement_mismatch', TX],
      ['unknown', 'settlement_mismatch', TX2],
    ]);
    expect(stripeCalls()).toHaveLength(0);
  });
});

describe('payments settled earlier', () => {
  it('are answered at the amount they were paid at after the price changed', async () => {
    const world = await seed();
    net.createIntent = unreachable;
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(503);
    await saveX402({ priceCents: 5 });
    await reloadMonetization({ quiet: true });
    expect(requiredOf(await handleGateRequest(gateHeaders(world), NOW)).accepts[0].amount).toBe('50000');
    net.createIntent = intent('succeeded');
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(200);
    expect(Object.fromEntries(stripeCalls().at(-1)!.body as URLSearchParams).amount).toBe('1');
    expect(cdpCalls('settle')).toHaveLength(1);
  });

  it('are answered once after x402 is turned off', async () => {
    const world = await seed();
    net.createIntent = unreachable;
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(503);
    net.createIntent = intent('succeeded');
    expect(await reconcileX402Payments(wallClock() + 31_000)).toMatchObject({ recorded: 1 });
    expect((await x402Route.DELETE(req('DELETE'))).status).toBe(200);
    // Nothing new is offered...
    expect((await handleGateRequest(gateHeaders(world), NOW)).status).toBe(401);
    // ...but the payment already recorded is answered, once.
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(200);
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(401);
    expect(cdpCalls('settle')).toHaveLength(1);
  });

  it('are recorded and answered after the host\'s x402 is turned off', async () => {
    const world = await seed();
    net.createIntent = unreachable;
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(503);
    await ctx.db.update(schema.monetizationHosts).set({ x402Enabled: false }).where(eq(schema.monetizationHosts.proxyHostId, world.hostId));
    await reloadMonetization({ quiet: true });
    net.createIntent = intent('succeeded');
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(200);
    // A payment never seen gets the plain denial there.
    expect((await handleGateRequest(withPayment(world, payment(9)), NOW)).status).toBe(401);
  });
});

describe('the deposit address belongs to the Stripe key', () => {
  const OTHER_KEY = 'sk_live_x402OtherKey9';
  const stripeReq = (method: string, body?: unknown) =>
    new NextRequest('http://localhost/api/v1/monetization/stripe', {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const x402View = async () => await (await x402Route.GET(req('GET'))).json();

  it('turns x402 off and clears the address when the Stripe key is replaced or removed, and says so', async () => {
    const world = await seed();
    expect((await handleGateRequest(gateHeaders(world), NOW)).status).toBe(402);
    // The same key again, or no key: x402 stays as it is.
    expect(await (await stripeRoute.PUT(stripeReq('PUT', { secretKey: STRIPE_KEY }))).json()).not.toHaveProperty('x402TurnedOff');
    expect(await (await stripeRoute.PUT(stripeReq('PUT', { topUpUrl: null }))).json()).not.toHaveProperty('x402TurnedOff');
    expect(await x402View()).toMatchObject({ enabled: true, configured: true });

    const replaced = await stripeRoute.PUT(stripeReq('PUT', { secretKey: OTHER_KEY }));
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toMatchObject({ x402TurnedOff: true, mode: 'live' });
    expect(await x402View()).toMatchObject({ enabled: false, configured: false, depositAddress: null, stripeReady: false });
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'monetization_x402', summary: expect.stringContaining('was replaced'), data: expect.objectContaining({ reason: 'key_replaced', depositAddress: DEPOSIT }) })
    );
    expect((await handleGateRequest(gateHeaders(world), NOW)).status).toBe(401);

    // Set up again with the new key, then the key removed.
    await saveX402({ depositAddress: { id: 'cda_1TestDepositAddress', address: DEPOSIT, livemode: true, accountId: ACCOUNT, keyFingerprint: stripeKeyFingerprint(OTHER_KEY) } });
    await reloadMonetization({ quiet: true });
    expect((await handleGateRequest(gateHeaders(world), NOW)).status).toBe(402);
    const removed = await stripeRoute.DELETE(stripeReq('DELETE'));
    expect(await removed.json()).toMatchObject({ x402TurnedOff: true, hasSecretKey: false });
    expect(await x402View()).toMatchObject({ enabled: false, depositAddress: null });
    expect((await handleGateRequest(gateHeaders(world), NOW)).status).toBe(401);
  });

  it('offers nothing with a test key', async () => {
    await saveStripe('sk_test_x402TestKeyA1');
    const world = await seed({
      x402: { depositAddress: { id: 'cda_1Test', address: DEPOSIT, livemode: false, keyFingerprint: stripeKeyFingerprint('sk_test_x402TestKeyA1') } },
    });
    // seed() saved the live key again: put the test key back.
    await saveStripe('sk_test_x402TestKeyA1');
    await reloadMonetization({ quiet: true });
    expect((await handleGateRequest(gateHeaders(world), NOW)).status).toBe(401);
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(401);
    expect(cdpCalls('verify')).toHaveLength(0);
  });

  it('offers nothing, and records nothing, with a key the address was not created with', async () => {
    const world = await seed();
    net.createIntent = unreachable;
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(503);
    // Another account's live key, written without going through the Stripe settings.
    await saveStripe(OTHER_KEY);
    await reloadMonetization({ quiet: true });
    expect((await handleGateRequest(gateHeaders(world), NOW)).status).toBe(401);
    net.createIntent = intent('succeeded');
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(503);
    expect(await reconcileX402Payments(wallClock() + 31_000)).toMatchObject({ recorded: 0 });
    expect(stripeCalls()).toHaveLength(1);
    expect((await payments())[0]).toMatchObject({ status: 'recording', errorReason: 'stripe_key_changed' });
    // The key the address was created with, back: recorded and answered.
    await saveStripe();
    await reloadMonetization({ quiet: true });
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(200);
  });
});

describe('the CDP SDK', () => {
  it('is loaded with its usage tracking and error reporting turned off', () => {
    expect(cdpEnvAtLoad).toEqual({ usage: 'true', errors: 'true' });
  });
});

describe('settings and the REST API', () => {
  async function storedValue() {
    return (await first(ctx.db.select().from(schema.settings).where(eq(schema.settings.key, X402_SETTING_KEY)).limit(1)))?.value ?? '';
  }

  it('turn x402 on: create the Stripe deposit address once, keep the CDP secret encrypted and never return it', async () => {
    await saveStripe();
    const saved = await x402Route.PUT(req('PUT', { enabled: true, priceCents: 2, cdpKeyId: CDP_KEY_ID, cdpKeySecret: CDP_SECRET }));
    expect(saved.status).toBe(200);
    const view = await saved.json();
    expect(view).toEqual({
      enabled: true,
      configured: true,
      priceCents: 2,
      network: 'eip155:8453',
      cdpKeyId: CDP_KEY_ID,
      hasCdpKeySecret: true,
      depositAddress: { address: DEPOSIT, livemode: true, accountId: ACCOUNT },
      stripeConfigured: true,
      stripeMode: 'live',
      stripeReady: true,
      networks: [{ id: 'eip155:8453', label: 'Base' }],
      notEnabledAt: null,
      notEnabledMessage: null,
    });
    expect(stripeCalls().map((call) => `${call.method} ${call.path}`)).toEqual(['GET /v1/account', 'POST /v1/crypto/deposit_addresses']);
    const [create] = stripeCalls('/v1/crypto/deposit_addresses');
    expect(Object.fromEntries(create.body as URLSearchParams)).toEqual({ network: 'base' });
    expect(create.headers.get('stripe-version')).toBe('2026-05-27.preview');
    expect(create.headers.get('authorization')).toBe(`Bearer ${STRIPE_KEY}`);
    expect(JSON.stringify(view)).not.toContain(CDP_SECRET);
    expect(await storedValue()).not.toContain(CDP_SECRET);
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'monetization_x402', data: expect.objectContaining({ depositAddress: DEPOSIT, stripeAccountId: ACCOUNT, cdpKeySecretChanged: true }) })
    );
    expect(JSON.stringify(vi.mocked(logAuditEvent).mock.calls)).not.toContain(CDP_SECRET);
    // Saved again: the address is kept, the secret too when left out.
    const again = await (await x402Route.PUT(req('PUT', { priceCents: 3 }))).json();
    expect(again).toMatchObject({ priceCents: 3, hasCdpKeySecret: true, depositAddress: { address: DEPOSIT } });
    expect(stripeCalls('/v1/crypto/deposit_addresses')).toHaveLength(1);
    // Saving never calls the facilitator.
    expect(cdpCalls()).toHaveLength(0);
  });

  it('validate the price, network, CDP key and turning on', async () => {
    await saveStripe();
    for (const body of [
      { priceCents: 0 },
      { priceCents: 1.5 },
      { priceCents: 100_001 },
      { network: 'eip155:84532' },
      { network: 'base' },
      { cdpKeyId: 'short' },
      { cdpKeySecret: 'not-a-cdp-secret' },
      { cdpKeySecret: Buffer.alloc(32).toString('base64') },
      { enabled: true },
      { enabled: true, cdpKeyId: CDP_KEY_ID },
      { payTo: DEPOSIT },
      { facilitatorUrl: 'https://facilitator.example.com' },
    ]) {
      expect((await x402Route.PUT(req('PUT', body))).status, JSON.stringify(body)).toBe(400);
    }
    expect(stripeCalls()).toHaveLength(0);
  });

  it('need a live Stripe key to turn on, and say what Stripe answered', async () => {
    const body = { enabled: true, cdpKeyId: CDP_KEY_ID, cdpKeySecret: CDP_SECRET };
    const noStripe = await x402Route.PUT(req('PUT', body));
    expect(noStripe.status).toBe(409);
    expect((await noStripe.json()).error).toContain('Set up Stripe first');
    // A test key: x402 offers Base mainnet, so it is refused before Stripe is asked.
    await saveStripe('sk_test_x402TestKeyA1');
    const testKey = await x402Route.PUT(req('PUT', body));
    expect(testKey.status).toBe(409);
    expect((await testKey.json()).error).toContain('live Stripe secret key');
    expect(stripeCalls()).toHaveLength(0);
    expect(await (await x402Route.GET(req('GET'))).json()).toMatchObject({ stripeMode: 'test', stripeReady: false, configured: false });
    await saveStripe();
    net.depositAddress = notEnabled;
    const refused = await x402Route.PUT(req('PUT', body));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe(NOT_ENABLED_MESSAGE);
    expect(await (await x402Route.GET(req('GET'))).json()).toMatchObject({ enabled: false, notEnabledMessage: NOT_ENABLED_MESSAGE, depositAddress: null });
    net.depositAddress = unreachable;
    expect((await x402Route.PUT(req('PUT', body))).status).toBe(409);
    net.depositAddress = () => reply(200, { id: 'cda_1Odd', object: 'crypto.deposit_address', livemode: true, network: 'solana', address: 'So1anaAddressExample' });
    expect((await x402Route.PUT(req('PUT', body))).status).toBe(409);
    // A test-mode address from a live key is not taken either.
    net.depositAddress = () => reply(200, { id: 'cda_1Test', object: 'crypto.deposit_address', livemode: false, network: 'base', address: DEPOSIT });
    expect((await x402Route.PUT(req('PUT', body))).status).toBe(409);
    // A key that may not read its account (a restricted key): the address is kept without the account id.
    net.account = () => reply(403, { error: { type: 'invalid_request_error', message: 'The provided key does not have the required permissions for this endpoint.' } });
    net.depositAddress = depositAddressOk;
    expect(await (await x402Route.PUT(req('PUT', body))).json()).toMatchObject({ enabled: true, configured: true, notEnabledMessage: null, depositAddress: { accountId: null } });
  });

  it('need the license to change, never to turn off or to pay', async () => {
    const world = await seed();
    await ctx.db.delete(schema.settings).where(eq(schema.settings.key, 'license'));
    expect((await x402Route.PUT(req('PUT', { priceCents: 5 }))).status).toBe(403);
    expect((await handleGateRequest(withPayment(world), NOW)).status).toBe(200);
    const off = await x402Route.DELETE(req('DELETE'));
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ enabled: false, configured: false, hasCdpKeySecret: false, depositAddress: { address: DEPOSIT } });
    expect(await storedValue()).not.toContain('cdpKeySecret":"');
    expect((await handleGateRequest(gateHeaders(world), NOW)).status).toBe(401);
  });

  it('list payments with the payer, amount, transaction and Stripe PaymentIntent', async () => {
    const world = await seed();
    await handleGateRequest(withPayment(world), NOW);
    const response = await x402PaymentsRoute.GET(new NextRequest('http://localhost/api/v1/monetization/x402/payments?status=settled'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      total: 1,
      payments: [{ proxyHostId: world.hostId, hostName: 'API', payer: PAYER.toLowerCase(), network: 'eip155:8453', amountMicros: 10_000, amountCents: 1, status: 'settled', transaction: TX, paymentIntentId: PI }],
    });
    expect((await x402PaymentsRoute.GET(new NextRequest('http://localhost/api/v1/monetization/x402/payments?status=pending'))).status).toBe(400);
  });

  it('set a host\'s own price in US cents', async () => {
    const world = await seed();
    const put = (body: unknown) =>
      hostRoute.PUT(
        new NextRequest(`http://localhost/api/v1/monetization/hosts/${world.hostId}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        { params: Promise.resolve({ id: String(world.hostId) }) }
      );
    expect((await put({ x402: { priceCents: 0 } })).status).toBe(400);
    expect((await put({ x402: { priceMicros: 10_000 } })).status).toBe(400);
    const saved = await put({ x402: { enabled: true, priceCents: 7 } });
    expect(saved.status).toBe(200);
    expect((await saved.json()).monetization.x402).toEqual({ enabled: true, priceCents: 7 });
    expect(requiredOf(await handleGateRequest(gateHeaders(world), NOW)).accepts[0].amount).toBe('70000');
  });
});
