/**
 * Server-side render of the API monetization page tabs and the consumer
 * portal: the overview from the ledger, the license notice, amounts in the
 * install's currency, the Stripe webhook instructions without secrets, and
 * the portal's top-up buttons.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/api-monetization',
  useSearchParams: () => new URLSearchParams(),
}));

import MonetizationClient from '@/ee/monetization/ui/MonetizationClient';
import PortalClient from '@/ee/monetization/ui/PortalClient';
import type { ConsumerSummary } from '@/ee/monetization/portal';
import { summarizeOverview } from '@/ee/monetization/overview-summary';
import type { ConsumerView, HostMonetizationView, MonetizationTab, PlanView, StripeSettingsView } from '@/ee/monetization/types';
import type { X402SettingsView } from '@/ee/monetization/x402/settings';

const stamp = '2026-10-03T10:00:00.000Z';
const plans: PlanView[] = [
  { id: 1, name: 'Standard', pricePerRequestMicros: 500, includedRequestsPerMonth: 1000, requestsPerMinute: 60, billing: 'prepaid', postpaidCapMicros: null, postpaidThresholdMicros: null, creditFailedAnswers: false, acceptX402: false, consumerCount: 1, createdAt: stamp, updatedAt: stamp },
  { id: 2, name: 'Metered', pricePerRequestMicros: 1000, includedRequestsPerMonth: 0, requestsPerMinute: null, billing: 'postpaid', postpaidCapMicros: 50_000_000, postpaidThresholdMicros: 20_000_000, creditFailedAnswers: true, acceptX402: false, consumerCount: 1, createdAt: stamp, updatedAt: stamp },
];
const consumers: ConsumerView[] = [
  { id: 7, name: 'Acme', email: 'dev@example.com', status: 'active', planId: 1, planName: 'Standard', balanceMicros: 12_500_000, overdraftAllowanceMicros: 0, includedRequestsUsed: 40, hasPortalLink: true, activeKeyCount: 2, billingOverride: null, billing: 'prepaid', postpaid: null, createdAt: stamp, updatedAt: stamp },
  { id: 8, name: 'Beta', email: null, status: 'disabled', planId: null, planName: null, balanceMicros: -1_000, overdraftAllowanceMicros: 5_000, includedRequestsUsed: 0, hasPortalLink: false, activeKeyCount: 0, billingOverride: null, billing: 'prepaid', postpaid: null, createdAt: stamp, updatedAt: stamp },
  {
    id: 9, name: 'Gamma', email: null, status: 'active', planId: 2, planName: 'Metered', balanceMicros: -12_400_000, overdraftAllowanceMicros: 0, includedRequestsUsed: 0, hasPortalLink: false, activeKeyCount: 1,
    billingOverride: null, billing: 'postpaid',
    postpaid: {
      openAmountMicros: 12_400_000, pendingChargeMicros: 0, capMicros: 50_000_000, thresholdMicros: 20_000_000, state: 'suspended', suspendedReason: 'payment_failed',
      suspendedAt: stamp, card: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, expired: false }, nextPeriodChargeAt: '2026-11-01T00:00:00.000Z',
    },
    createdAt: stamp, updatedAt: stamp,
  },
];
const hosts: HostMonetizationView[] = [
  {
    proxyHostId: 3, name: 'API', domains: ['api.example.com'], hostEnabled: true,
    monetization: {
      enabled: true, keyHeader: 'X-API-Key', allowedPlanIds: [1],
      x402: { enabled: false, priceCents: null },
    },
    conflicts: [],
  },
  { proxyHostId: 4, name: 'Intranet', domains: ['intra.example.com'], hostEnabled: true, monetization: null, conflicts: ['a basic-auth access list'] },
];
const stripe: StripeSettingsView = {
  configured: true, hasSecretKey: true, hasWebhookSecret: true, mode: 'test', currency: 'eur',
  topUpAmountsMicros: [10_000_000, 25_000_000], topUpUrl: null,
  webhookUrl: 'https://dash.example.com/api/monetization/stripe/webhook',
  webhookEvents: ['checkout.session.completed', 'checkout.session.async_payment_succeeded'],
  automaticTax: false,
};

const overview = summarizeOverview({
  now: new Date('2026-10-03T11:36:00.000Z'),
  currency: 'eur',
  daily: [
    { day: '2026-10-02', type: 'usage', amountMicros: -2_000, requests: 44, freeRequests: 40, entries: 2 },
    { day: '2026-10-01', type: 'topup', amountMicros: 10_000_000, requests: 0, freeRequests: 0, entries: 1 },
    { day: '2026-09-20', type: 'topup', amountMicros: 25_000_000, requests: 0, freeRequests: 0, entries: 1 },
  ],
  consumerUsage: [{ consumerId: 7, type: 'usage', amountMicros: -2_000, requests: 44, freeRequests: 40 }],
  keys: [{ consumerId: 7, lastUsedAt: '2026-10-03T11:35:00.000Z', revoked: 0, lastRevokedAt: null }],
  funded: new Set([7]),
  consumers,
  lastTopUp: { consumerId: 7, consumerName: 'Acme', amountMicros: 10_000_000, at: '2026-10-01T12:00:00.000Z' },
});

const X402_SETTINGS: X402SettingsView = {
  enabled: true, configured: true, priceCents: 1, network: 'eip155:8453', cdpKeyId: 'organizations/example/apiKeys/test-key', hasCdpKeySecret: true,
  depositAddress: { address: '0x209693bc6afc0c5328ba36faf03c514ef312287c', livemode: true, accountId: 'acct_1ExampleAccount' }, stripeConfigured: true,
  stripeMode: 'live', stripeReady: true, networks: [{ id: 'eip155:8453', label: 'Base' }], notEnabledAt: null, notEnabledMessage: null,
};

function render(tab: MonetizationTab, configurable = true, canManageReplicas = true, x402: Partial<X402SettingsView> = {}) {
  return renderToStaticMarkup(
    createElement(MonetizationClient, {
      initialTab: tab,
      canManageReplicas,
      overview,
      plans,
      consumers,
      hosts,
      stripe,
      ledger: {
        entries: [
          { id: 1, consumerId: 7, consumerName: 'Acme', type: 'usage', amountMicros: -2_000, balanceAfterMicros: 12_500_000, requests: 4, freeRequests: 0, reference: 'usage:7:2026-10-03T10', description: null, createdBy: null, createdAt: stamp, updatedAt: stamp },
          { id: 2, consumerId: 7, consumerName: 'Acme', type: 'topup', amountMicros: 10_000_000, balanceAfterMicros: 12_502_000, requests: 0, freeRequests: 0, reference: 'stripe:cs_test_1', description: 'Stripe Checkout top-up', createdBy: null, createdAt: stamp, updatedAt: stamp },
        ],
        total: 2, page: 1, perPage: 50,
      },
      configurable,
      canWrite: true,
      canManagePayments: true,
      standalone: true,
      instanceMode: 'standalone',
      options: { usageRetentionMonths: 13, replicas: { mode: 'off', gateUrl: null, problem: null }, analyticsAvailable: true },
      x402: { ...X402_SETTINGS, ...x402 },
      x402Payments: {
        payments: [{
          id: 1, proxyHostId: 3, hostName: 'API', consumerId: null, consumerName: null, payer: '0x857b06519e91e3a54538791bdbb0e22373e36b66',
          network: 'eip155:8453', amountMicros: 10_000, amountCents: 1, status: 'settled', transaction: `0x${'ab'.repeat(32)}`,
          paymentIntentId: 'pi_3ExampleX402Intent', errorReason: null, createdAt: stamp, updatedAt: stamp,
        }],
        total: 1, page: 1, perPage: 20,
      },
      editionLabel: 'Enterprise',
    })
  );
}

describe('API monetization page', () => {
  it('opens on the overview: money paid in and charged this month, from the ledger', () => {
    const html = render('overview');
    expect(html).toContain('API monetization');
    expect(html).toContain('Paid in through Stripe, October');
    expect(html).toContain('€10.00');
    expect(html).toContain('1 top-up · September €25.00');
    expect(html).toContain('Charged for requests, October');
    expect(html).toContain('4 charged, 40 free');
    expect(html).toContain('Metered requests, October');
    expect(html).toContain('To 11:36 today');
    expect(html).toContain('Prepaid balances');
    expect(html).toContain('Held for 1 consumer');
    expect(html).toContain('Top consumers, October');
    expect(html).toContain('Metered requests per day, last 30 days');
    expect(html).toContain('1 Oct · free requests reset');
    expect(html).toContain('€10.00</span> from Acme');
    expect(html).toContain('Monetized hosts');
    expect(html).not.toMatch(/revenue/i);
  });

  it('shows plans with prices in the currency', () => {
    const html = render('plans');
    expect(html).toContain('Standard');
    expect(html).toContain('€0.0005');
    expect(html).not.toContain('needs a license with it');
  });

  it('shows consumers with balances, plans, this month’s usage and key use', () => {
    const html = render('consumers');
    expect(html).toContain('€12.50');
    expect(html).toContain('-€0.001');
    expect(html).toContain('No plan');
    expect(html).toContain('40 of 1,000');
    expect(html).toContain('used <span class="num">11:35</span>');
    expect(html).toContain('aria-label="More actions for Acme"');
  });

  it('shows hosts with their key header, allowed plans and conflicts', () => {
    const html = render('hosts');
    expect(html).toContain('X-API-Key');
    expect(html).toContain('Uses a basic-auth access list');
  });

  it('shows the webhook URL and events, never secrets', () => {
    const html = render('stripe');
    expect(html).toContain('https://dash.example.com/api/monetization/stripe/webhook');
    expect(html).toContain('checkout.session.async_payment_succeeded');
    expect(html).toContain('Test mode');
    expect(html).toContain('Stored; leave empty to keep it');
  });

  it('shows the ledger', () => {
    const html = render('ledger');
    expect(html).toContain('4 requests, 0 free');
    expect(html).toContain('Stripe Checkout top-up');
  });

  it('explains the license and stays read-only without one', () => {
    const html = render('plans', false);
    expect(html).toContain('needs a license with it (Enterprise edition)');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Needs a license with API monetization"/);
  });
});

describe('consumer portal', () => {
  const summary: ConsumerSummary = {
    consumer: { id: 7, name: 'Acme', status: 'active' },
    plan: { id: 1, name: 'Standard', pricePerRequestMicros: 500, includedRequestsPerMonth: 1000, requestsPerMinute: null },
    currency: 'usd',
    balanceMicros: 0,
    overdraftAllowanceMicros: 0,
    includedRequestsUsed: 1000,
    includedRequestsRemaining: 0,
    topUpsAvailable: true,
    topUpAmountsMicros: [10_000_000, 25_000_000],
    billing: 'prepaid',
    postpaid: null,
    recentActivity: [{ type: 'usage', amountMicros: -500, balanceAfterMicros: 0, requests: 1, freeRequests: 0, createdAt: stamp, updatedAt: stamp }],
  };

  it('shows the balance, the plan and a button per top-up amount', () => {
    const html = renderToStaticMarkup(createElement(PortalClient, { brandName: 'Ingressi', mode: 'token', token: 'x'.repeat(43), initial: summary, result: 'topup-success' }));
    expect(html).toContain('API account: Acme');
    expect(html).toContain('0 USD');
    expect(html).toContain('10.00 USD');
    expect(html).toContain('25.00 USD');
    expect(html).toContain('the payment went through');
  });

  it('asks for an API key on the key-based page and reports an invalid link', () => {
    expect(renderToStaticMarkup(createElement(PortalClient, { brandName: 'Ingressi', mode: 'key' }))).toContain('Show my balance');
    expect(renderToStaticMarkup(createElement(PortalClient, { brandName: 'Ingressi', mode: 'token', initial: null }))).toContain('This portal link is not valid');
  });
});

describe('phase 2 views', () => {
  it('shows a postpaid consumer with its open amount, cap, card and suspension', () => {
    const html = render('consumers');
    expect(html).toContain('Gamma');
    expect(html).toContain('Postpaid');
    expect(html).toContain('Suspended');
    expect(html).toContain('postpaid cap');
    expect(html).toContain('owed, unpaid');
  });

  it('shows the plans billing and the failed-answer option', () => {
    const html = render('plans');
    expect(html).toContain('5xx credited back');
    expect(html).toContain('cap €50.00');
  });

  it('shows the x402 settings, the responsibilities note and the payments, never a secret', () => {
    const html = render('x402');
    expect(html).toContain('x402 pay-per-request');
    expect(html).toContain('0x209693bc6afc0c5328ba36faf03c514ef312287c');
    expect(html).toContain('Live mode, Stripe account acct_1ExampleAccount');
    expect(html).toContain('Stripe receives the payments.');
    expect(html).toContain('Stripe custodies and settles the funds.');
    expect(html).toContain('organizations/example/apiKeys/test-key');
    expect(html).toContain('Stored; leave empty to keep it');
    expect(html).toContain('$0.01 USDC');
    expect(html).toContain('0x857b06…e36b66');
    expect(html).toContain('pi_3ExampleX402Intent');
    expect(html).not.toContain('Stablecoins and Crypto is not enabled');
  });

  it('says what to do when Stripe has not enabled Stablecoins and Crypto', () => {
    const html = render('x402', true, true, { notEnabledAt: stamp, notEnabledMessage: 'Outside the US, the account owner must email machine-payments@stripe.com with the Stripe account ID to request access.' });
    expect(html).toContain('Stablecoins and Crypto is not enabled on your Stripe account.');
    expect(html).toContain('machine-payments@stripe.com');
  });

  it('says x402 needs a live Stripe key', () => {
    const html = render('x402', true, true, { stripeMode: 'test', stripeReady: false, configured: false });
    expect(html).toContain('it needs a live Stripe secret key');
    expect(html).toContain('x402 is not offered: the Stripe key is not the live key the deposit address was created with.');
  });

  it('asks for Stripe first when no Stripe key is set', () => {
    const html = render('x402', true, true, { stripeConfigured: false, stripeMode: null, stripeReady: false, depositAddress: null, configured: false });
    expect(html).toContain('Set up Stripe on the Stripe tab first');
    expect(html).toContain('Not created yet');
  });

  it('lists x402 payments under the ledger', () => {
    const html = render('ledger');
    expect(html).toContain('x402 payments');
    expect(html).toContain('$0.01 USDC');
  });

  it('shows the settings: retention and replica serving', () => {
    const html = render('settings');
    expect(html).toContain('Usage history');
    expect(html).toContain('Keep for (months)');
    expect(html).toContain('Serve monetized hosts on replicas');
    expect(html).toContain('Failed-answer credits');
    expect(html).not.toContain('needs permission to manage instances');
  });

  it('asks for instances:write before replica serving can be changed', () => {
    const html = render('settings', true, false);
    expect(html).toContain('Changing this needs permission to manage instances (instances:write) as well.');
  });

  it('shows a postpaid portal: open amount, cap, card, the pay button and the suspension', () => {
    const summary: ConsumerSummary = {
      consumer: { id: 9, name: 'Gamma', status: 'active' },
      plan: { id: 2, name: 'Metered', pricePerRequestMicros: 1000, includedRequestsPerMonth: 0, requestsPerMinute: null },
      currency: 'usd',
      balanceMicros: -12_400_000,
      overdraftAllowanceMicros: 0,
      includedRequestsUsed: 0,
      includedRequestsRemaining: 0,
      topUpsAvailable: false,
      topUpAmountsMicros: [],
      billing: 'postpaid',
      postpaid: {
        openAmountMicros: 12_400_000, pendingChargeMicros: 0, capMicros: 50_000_000, thresholdMicros: 20_000_000, state: 'suspended',
        suspendedReason: 'payment_failed', suspendedAt: stamp, card: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, expired: false },
        nextPeriodChargeAt: '2026-11-01T00:00:00.000Z', paymentsAvailable: true,
      },
      recentActivity: [
        { type: 'credit', amountMicros: 3000, balanceAfterMicros: -12_400_000, requests: 3, freeRequests: 0, createdAt: stamp, updatedAt: stamp },
      ],
    };
    const html = renderToStaticMarkup(createElement(PortalClient, { brandName: 'Ingressi', mode: 'token', token: 'x'.repeat(43), initial: summary, result: 'card-saved' }));
    expect(html).toContain('Unpaid usage');
    expect(html).toContain('12.40 USD');
    expect(html).toContain('Limit 50.00 USD');
    expect(html).toContain('visa ending 4242');
    expect(html).toContain('Pay 12.40 USD now');
    expect(html).toContain('A charge of your saved card failed');
    expect(html).toContain('Your card is saved');
    expect(html).toContain('3 failed answer(s)');
    expect(html).not.toContain('Top up');
  });
});
