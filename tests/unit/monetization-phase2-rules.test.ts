/**
 * API monetization, phase 2, without a database: charge ids (what the gate
 * hands Caddy to log, and only it can issue), reading failed answers from
 * access log lines, postpaid billing rules, retention cutoffs, the replica
 * section's validation and the replica's reading of its master's answers.
 */
import { describe, expect, it } from 'vitest';
import { chargeIdKey, issueChargeId, readChargeId } from '@/ee/monetization/charge-id';
import { failedAnswerChargeIds, groupChargeIds, MAX_CHARGE_AGE_MS } from '@/ee/monetization/answer-credits';
import {
  cardExpiresAt,
  chargeableMicros,
  effectiveThreshold,
  isCardExpired,
  minimumChargeMicros,
  nextPeriodStart,
  openAmountToPay,
  previousPeriod,
} from '@/ee/monetization/billing-rules';
import { retentionCutoff } from '@/ee/monetization/retention';
import { isGateUrlAllowed, replicaSectionError } from '@/ee/monetization/replica-index';
import { deriveAllowanceCredential, readAllowanceReply, readDenial, parseAllowanceRequest } from '@/ee/monetization/replica-allowance';

const KEY = chargeIdKey('a'.repeat(64));
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);

describe('charge ids', () => {
  it('carry the consumer, the charge, whether it was free and when, and are unique', () => {
    const id = issueChargeId(KEY, { consumerId: 12, chargedMicros: 1_500, free: false, issuedAtMs: NOW });
    expect(id).toMatch(/^c1\.12\.1500\.0\.\d{10}\.[a-f0-9]{12}\.[A-Za-z0-9_-]{22}$/);
    expect(readChargeId(KEY, id)).toEqual({ consumerId: 12, chargedMicros: 1_500, free: false, issuedAtMs: NOW });
    expect(issueChargeId(KEY, { consumerId: 12, chargedMicros: 1_500, free: false, issuedAtMs: NOW })).not.toBe(id);
  });

  it('are refused when forged, changed, of another install or malformed', () => {
    const id = issueChargeId(KEY, { consumerId: 3, chargedMicros: 0, free: true, issuedAtMs: NOW });
    expect(readChargeId(chargeIdKey('b'.repeat(64)), id)).toBeNull();
    // A larger charge or another consumer with the same MAC.
    expect(readChargeId(KEY, id.replace('c1.3.0.1.', 'c1.3.900000.1.'))).toBeNull();
    expect(readChargeId(KEY, id.replace('c1.3.', 'c1.4.'))).toBeNull();
    for (const bad of [null, 42, '', 'c1.3', `${id}x`, id.toUpperCase(), 'x'.repeat(500)]) expect(readChargeId(KEY, bad)).toBeNull();
  });

  it('are grouped by consumer; duplicates, forged, too old and future ones are dropped', () => {
    const fresh = issueChargeId(KEY, { consumerId: 1, chargedMicros: 100, free: false, issuedAtMs: NOW - 1000 });
    const free = issueChargeId(KEY, { consumerId: 1, chargedMicros: 0, free: true, issuedAtMs: NOW - 2000 });
    const lastMonth = issueChargeId(KEY, { consumerId: 2, chargedMicros: 0, free: true, issuedAtMs: Date.UTC(2026, 8, 30, 23, 59) });
    const old = issueChargeId(KEY, { consumerId: 1, chargedMicros: 100, free: false, issuedAtMs: NOW - MAX_CHARGE_AGE_MS - 1000 });
    const future = issueChargeId(KEY, { consumerId: 1, chargedMicros: 100, free: false, issuedAtMs: NOW + 3_600_000 });
    const forged = issueChargeId(chargeIdKey('c'.repeat(64)), { consumerId: 1, chargedMicros: 100, free: false, issuedAtMs: NOW });
    const groups = groupChargeIds(KEY, [fresh, fresh, free, lastMonth, old, future, forged], NOW);
    expect([...groups.keys()].sort()).toEqual([1, 2]);
    expect(groups.get(1)).toEqual([
      { chargeId: fresh, amountMicros: 100, free: false, sameMonth: true },
      { chargeId: free, amountMicros: 0, free: true, sameMonth: true },
    ]);
    expect(groups.get(2)).toEqual([{ chargeId: lastMonth, amountMicros: 0, free: true, sameMonth: false }]);
  });
});

describe('failed answers in the access log', () => {
  const line = (status: number, charge?: unknown, msg = 'handled request') =>
    JSON.stringify({ level: 'info', msg, status, request: { host: 'api.example.com' }, ...(charge === undefined ? {} : { ingressi_charge: charge }) });

  it('are the 5xx lines with a charge id, the gateway\'s own 502, 503 and 504 included', () => {
    expect(failedAnswerChargeIds([line(500, 'a1'), line(502, 'a2'), line(503, 'a3'), line(504, 'a4'), line(599, 'a5')])).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
  });

  it('skip answers that are not failures, lines without an id, other messages and garbage', () => {
    expect(
      failedAnswerChargeIds([
        line(200, 'b1'),
        line(404, 'b2'),
        line(429, 'b3'),
        line(500),
        line(500, ''),
        line(500, 42),
        line(500, 'b4', 'request blocked'),
        'not json ingressi_charge',
        line(600, 'b5'),
      ])
    ).toEqual([]);
  });
});

describe('postpaid rules', () => {
  it('a card works through the end of its expiry month (UTC)', () => {
    expect(cardExpiresAt(12, 2026)).toBe(Date.UTC(2027, 0, 1));
    expect(isCardExpired(10, 2026, Date.UTC(2026, 9, 31, 23, 59))).toBe(false);
    expect(isCardExpired(10, 2026, Date.UTC(2026, 10, 1))).toBe(true);
    for (const [month, year] of [[null, 2030], [13, 2030], [0, 2030], [5, 1999]] as const) expect(cardExpiresAt(month, year)).toBeNull();
    expect(isCardExpired(null, null)).toBe(false);
  });

  it('charges whole cents, rounded down, less what is on its way; pays open amounts rounded up', () => {
    expect(chargeableMicros(12_345_678, 0, 'usd')).toBe(12_340_000);
    expect(chargeableMicros(12_345_678, 2_000_000, 'usd')).toBe(10_340_000);
    expect(chargeableMicros(1_000, 5_000, 'usd')).toBe(0);
    expect(chargeableMicros(-5, 0, 'usd')).toBe(0);
    expect(chargeableMicros(1_999_999, 0, 'jpy')).toBe(1_000_000);
    expect(openAmountToPay(12_345_678, 'usd')).toBe(12_350_000);
    expect(openAmountToPay(-1, 'usd')).toBe(0);
  });

  it('knows Stripe minimums, the default threshold and billing periods', () => {
    expect(minimumChargeMicros('usd')).toBe(500_000);
    expect(minimumChargeMicros('gbp')).toBe(300_000);
    expect(minimumChargeMicros('jpy')).toBe(50_000_000);
    expect(minimumChargeMicros('xyz')).toBe(10_000);
    expect(effectiveThreshold(50_000_000, null)).toBe(25_000_000);
    expect(effectiveThreshold(50_000_000, 80_000_000)).toBe(50_000_000);
    expect(effectiveThreshold(50_000_000, 10_000_000)).toBe(10_000_000);
    expect(previousPeriod(Date.UTC(2026, 0, 1, 0, 1))).toBe('2025-12');
    expect(nextPeriodStart(Date.UTC(2026, 11, 31))).toBe('2027-01-01T00:00:00.000Z');
  });

  it('retention keeps whole calendar months back from now', () => {
    expect(retentionCutoff(Date.UTC(2026, 9, 4, 12), 13)).toBe('2025-09-04T12:00:00.000Z');
    expect(retentionCutoff(Date.UTC(2026, 2, 31), 1)).toBe('2026-03-03T00:00:00.000Z');
  });
});

describe('the replica section', () => {
  const checks = {
    isProxyHost: (row: unknown) => typeof row === 'object' && row !== null && typeof (row as { id?: unknown }).id === 'number',
    isWafRuleExclusion: () => true,
    proxyHostContentError: () => null,
  };
  const section = (values: Record<string, unknown> = {}) => ({
    v: 1,
    mode: 'allowance',
    namespace: null,
    gateUrl: 'https://dash.example.com',
    currency: 'eur',
    topUpUrl: 'https://dash.example.com/api-portal',
    hosts: [{ proxyHostId: 3, keyHeader: 'Authorization', allowedPlanIds: [] }],
    plans: [{ id: 1, name: 'Standard', priceMicros: 1000, includedPerMonth: 0, perMinute: null, billing: 'prepaid', capMicros: null, creditFailed: false }],
    consumers: [{ id: 2, active: true, planId: 1, overdraftMicros: 0, billing: null, hasCard: false, cardExpMonth: null, cardExpYear: null, suspended: null }],
    keys: [{ id: 5, consumerId: 2, prefix: 'ik_0123456789ab', hash: 'sealed' }],
    proxyHosts: [{ id: 3 }],
    wafRuleExclusions: [{ id: 9, proxyHostId: 3 }],
    ...values,
  });

  it('accepts a well-formed section, and none', () => {
    expect(replicaSectionError(section(), checks)).toBeNull();
    expect(replicaSectionError(section({ mode: 'shared', namespace: 'ingressi:0123abcd:', gateUrl: null }), checks)).toBeNull();
    expect(replicaSectionError(null, checks)).toBeNull();
  });

  it('refuses a proxy host the section does not gate, and any malformed part', () => {
    expect(replicaSectionError(section({ proxyHosts: [{ id: 3 }, { id: 4 }] }), checks)).toBe('Invalid API monetization replica section');
    expect(replicaSectionError(section({ wafRuleExclusions: [{ id: 9, proxyHostId: null }] }), checks)).not.toBeNull();
    for (const bad of [
      { v: 2 },
      { mode: 'off' },
      { mode: 'shared', namespace: 'no colon' },
      { gateUrl: 'ftp://dash.example.com' },
      { currency: 'EURO' },
      { keys: [{ id: 5, consumerId: 2, prefix: 'pk_x', hash: 'h' }] },
      { hosts: [{ proxyHostId: 3, keyHeader: 'Bad Header', allowedPlanIds: [] }] },
      { consumers: [{ id: 2, active: 'yes' }] },
    ]) {
      expect(replicaSectionError(section(bad), checks), JSON.stringify(bad)).not.toBeNull();
    }
  });
});

describe('a replica reading its master', () => {
  it('rebuilds denials field by field and turns anything unknown into 503', () => {
    expect(readDenial({ allow: false, status: 402, error: 'payment_required', balanceMicros: -5, priceMicros: 10, planId: 1, extra: '<script>' })).toEqual({
      allow: false, status: 402, error: 'payment_required', balanceMicros: -5, priceMicros: 10, planId: 1, acceptX402: false,
    });
    expect(readDenial({ error: 'payment_overdue', reason: 'whatever' })).toMatchObject({ error: 'payment_overdue', reason: 'payment_failed' });
    expect(readDenial({ error: 'rate_limited', retryAfterSeconds: 9_999, limit: 5 })).toMatchObject({ retryAfterSeconds: 60, limit: 5 });
    expect(readDenial({ error: 'invalid_api_key', keyHeader: 'X-Bad Header' })).toMatchObject({ status: 401, keyHeader: 'Authorization' });
    for (const bad of [null, {}, { error: 'forbidden' }, { error: 'payment_required', balanceMicros: 'x' }]) {
      expect(readDenial(bad)).toEqual({ allow: false, status: 503, error: 'unavailable' });
    }
  });

  it('accepts only allowances within the limits', () => {
    const lease = { id: '00000000-0000-4000-8000-000000000000', granted: 50, free: 10, priceMicros: 1000, planId: 1, ttlMs: 30_000 };
    expect(readAllowanceReply({ lease })).toEqual({ lease });
    for (const bad of [{ ...lease, granted: 51 }, { ...lease, granted: 0 }, { ...lease, free: 60 }, { ...lease, ttlMs: 60_000 }, { ...lease, id: 'x' }]) {
      expect(() => readAllowanceReply({ lease: bad })).toThrow();
    }
    expect(() => readAllowanceReply('nope')).toThrow();
    expect(readAllowanceReply({ reported: 3 })).toEqual({ reported: 3 });
  });

  it('the master parses allowance requests strictly: a lease names the key the client presented', () => {
    const report = { leaseId: '00000000-0000-4000-8000-000000000000', used: 3 };
    const key = 'ik_0123456789ab_secretpart';
    expect(parseAllowanceRequest({ v: 1, hostId: 1, key, want: 500, node: 'node-1', reports: [report] })).toEqual({ kind: 'lease', hostId: 1, key, want: 50, node: 'node-1', reports: [report] });
    expect(parseAllowanceRequest({ v: 1, reportOnly: true, reports: [report] })).toEqual({ kind: 'report', reports: [report] });
    for (const bad of [
      null,
      { v: 2 },
      { v: 1, hostId: 0, key, want: 1, node: 'n' },
      // Every lease names the replica's node.
      { v: 1, hostId: 1, key, want: 1 },
      { v: 1, hostId: 1, key, want: 1, node: 'has space' },
      { v: 1, hostId: 1, key, want: 1, node: 'n'.repeat(41) },
      // Ids alone no longer make a request: the master checks the key itself.
      { v: 1, hostId: 1, consumerId: 2, keyId: 3, want: 1 },
      { v: 1, hostId: 1, key: 'has space', want: 1, node: 'n' },
      { v: 1, hostId: 1, key: 'k'.repeat(129), want: 1, node: 'n' },
      { v: 1, reportOnly: true, reports: [{ leaseId: 'x', used: 1 }] },
      { v: 1, reportOnly: true, reports: [{ ...report, used: -1 }] },
    ]) {
      expect(parseAllowanceRequest(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('derives an allowance credential from the sync secret that is not the secret and opens nothing else', () => {
    const token = 'f'.repeat(64);
    const credential = deriveAllowanceCredential(token);
    expect(credential).toMatch(/^mza_[A-Za-z0-9_-]{43}$/);
    expect(credential).not.toContain(token);
    expect(deriveAllowanceCredential(token)).toBe(credential);
    expect(deriveAllowanceCredential('e'.repeat(64))).not.toBe(credential);
  });

  it('allows a gate URL over plain HTTP only where sync over HTTP is allowed', () => {
    expect(isGateUrlAllowed('https://dash.example.com', false)).toBe(true);
    expect(isGateUrlAllowed('http://dash.example.com', false)).toBe(false);
    expect(isGateUrlAllowed('http://dash.example.com', true)).toBe(true);
    for (const bad of ['https://user:pw@dash.example.com', 'https://dash.example.com/?a=1', 'https://dash.example.com/#x', 'ftp://dash.example.com', 'dash.example.com', null]) {
      expect(isGateUrlAllowed(bad, true), String(bad)).toBe(false);
    }
  });
});
