/**
 * The online license check without a database: status statements (format,
 * signature, context, dates), how an online key (v2) is evaluated with the
 * stored statements and first-seen times, the one request to the license
 * server, and when the scheduler asks.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sign } from 'node:crypto';
import {
  canConfigure,
  evaluateLicense,
  FIRST_CHECK_ALLOWANCE_DAYS,
  LicenseStatementError,
  signingInput,
  verifyLicenseStatement,
} from '@/ee/licensing/license';
import { postLicenseStatus } from '@/ee/licensing/online-check-transport';
import { isOnlineCheckDue, keyFingerprint, ONLINE_CHECK_RETRY_MS } from '@/ee/licensing/online-check';
import { EMPTY_LICENSE_CHECK, parseStoredLicenseCheck, withFirstSeen } from '@/ee/licensing/online-check-state';
import { setTrustedLicenseKeysForTests } from '@/ee/licensing/public-keys';
import { licenseStatusUrl } from '@/ee/licensing/auto-update-env';
import { createTestSigner, licensePayload, signLicense, signStatement, statementPayload } from '../helpers/license';

const signer = createTestSigner('online-test');
const DAY = 86_400_000;
const NOW = new Date('2027-01-10T00:00:00.000Z');

const onlineKey = (overrides: Record<string, unknown> = {}) => signLicense(signer, licensePayload(signer, { v: 2, ...overrides }));
const offlineKey = () => signLicense(signer, licensePayload(signer));
const statement = (overrides: Record<string, unknown> = {}) => signStatement(signer, statementPayload(signer, overrides));
const iso = (ms: number) => new Date(ms).toISOString();

beforeAll(() => setTrustedLicenseKeysForTests(signer.keys));
afterAll(() => setTrustedLicenseKeysForTests(null));

describe('verifyLicenseStatement', () => {
  it('accepts a statement signed by a trusted key', () => {
    expect(verifyLicenseStatement(statement(), signer.keys, NOW)).toMatchObject({ id: 'LIC-TEST', status: 'active' });
    expect(verifyLicenseStatement(statement({ status: 'revoked' }), signer.keys, NOW).status).toBe('revoked');
  });

  it('refuses a statement signed over the license key context (and a key passed as a statement)', () => {
    const payloadPart = Buffer.from(JSON.stringify(statementPayload(signer)), 'utf8').toString('base64url');
    const signature = sign(null, signingInput(payloadPart), signer.privateKey).toString('base64url');
    expect(() => verifyLicenseStatement(`s1.${payloadPart}.${signature}`, signer.keys, NOW)).toThrow(/signature does not match/);
    expect(() => verifyLicenseStatement(onlineKey(), signer.keys, NOW)).toThrow(LicenseStatementError);
  });

  it('refuses a changed payload, an untrusted key and an unknown key id', () => {
    const [prefix, , signature] = statement().split('.');
    const forged = Buffer.from(JSON.stringify(statementPayload(signer, { status: 'revoked' }))).toString('base64url');
    expect(() => verifyLicenseStatement(`${prefix}.${forged}.${signature}`, signer.keys, NOW)).toThrow(/signature does not match/);
    const other = createTestSigner(signer.kid);
    expect(() => verifyLicenseStatement(signStatement(other, statementPayload(other)), signer.keys, NOW)).toThrow(/signature does not match/);
    expect(() => verifyLicenseStatement(statement({ kid: 'nope' }), signer.keys, NOW)).toThrow(/unknown key/);
  });

  it.each([
    ['an unknown field', { extra: true }],
    ['an unknown status', { status: 'suspended' }],
    ['another version', { v: 2 }],
    ['expiry before issue', { exp: '2026-12-01T00:00:00.000Z' }],
    ['a validity over 31 days', { exp: '2027-02-02T00:00:01.000Z' }],
    ['an empty id', { id: ' ' }],
  ])('refuses a statement with %s', (_name, overrides) => {
    expect(() => verifyLicenseStatement(statement(overrides), signer.keys, NOW)).toThrow(LicenseStatementError);
  });

  it('refuses a statement dated more than a day ahead, and allows clock skew within a day', () => {
    expect(() => verifyLicenseStatement(statement({ iat: iso(NOW.getTime() + 2 * DAY) }), signer.keys, NOW)).toThrow(/future/);
    expect(() => verifyLicenseStatement(statement({ iat: iso(NOW.getTime() + DAY / 2) }), signer.keys, NOW)).not.toThrow();
  });

  it.each([['empty', ''], ['wrong prefix', 'v1.abc.def'], ['two parts', 's1.abc'], ['not JSON', `s1.${Buffer.from('x').toString('base64url')}.AAAA`]])(
    'refuses a malformed statement (%s)',
    (_name, token) => {
      expect(() => verifyLicenseStatement(token, signer.keys, NOW)).toThrow(LicenseStatementError);
    }
  );
});

describe('evaluateLicense with an online key', () => {
  const seen = (at: number) => ({ firstSeen: { 'LIC-TEST': iso(at) } });

  it('leaves offline keys as they were, whatever is stored', () => {
    const state = evaluateLicense(offlineKey(), signer.keys, NOW, { statements: { 'LIC-TEST': statement({ status: 'revoked' }) } });
    expect(state).toMatchObject({ status: 'active', onlineCheck: null });
  });

  it('is active and confirmed with a current active statement', () => {
    const state = evaluateLicense(onlineKey(), signer.keys, NOW, { statements: { 'LIC-TEST': statement() }, ...seen(NOW.getTime() - 30 * DAY) });
    expect(state.status).toBe('active');
    expect(state.onlineCheck).toEqual({ state: 'confirmed', confirmedAt: '2027-01-01T00:00:00.000Z', validUntil: '2027-01-15T00:00:00.000Z' });
    expect(canConfigure(state, 'alerting')).toBe(true);
  });

  it('is unconfirmed (read-only) once the statement expires', () => {
    const later = new Date('2027-01-15T00:00:01.000Z');
    const state = evaluateLicense(onlineKey(), signer.keys, later, { statements: { 'LIC-TEST': statement() }, ...seen(NOW.getTime() - 30 * DAY) });
    expect(state.status).toBe('unconfirmed');
    expect(state.onlineCheck).toMatchObject({ state: 'unconfirmed', confirmedAt: '2027-01-01T00:00:00.000Z', validUntil: '2027-01-15T00:00:00.000Z' });
    expect(canConfigure(state, 'alerting')).toBe(false);
    expect(state.features.length).toBeGreaterThan(0);
  });

  it(`works for ${FIRST_CHECK_ALLOWANCE_DAYS} days after the license was first seen, then is unconfirmed`, () => {
    const firstSeen = NOW.getTime() - (FIRST_CHECK_ALLOWANCE_DAYS * DAY - 1000);
    const within = evaluateLicense(onlineKey(), signer.keys, NOW, seen(firstSeen));
    expect(within.status).toBe('active');
    expect(within.onlineCheck).toEqual({ state: 'pending', confirmedAt: null, validUntil: iso(firstSeen + FIRST_CHECK_ALLOWANCE_DAYS * DAY) });
    expect(canConfigure(within, 'alerting')).toBe(true);
    const after = evaluateLicense(onlineKey(), signer.keys, new Date(NOW.getTime() + 2000), seen(firstSeen));
    expect(after.status).toBe('unconfirmed');
    expect(canConfigure(after, 'alerting')).toBe(false);
  });

  it('counts a license never seen as seen now', () => {
    expect(evaluateLicense(onlineKey(), signer.keys, NOW).onlineCheck).toMatchObject({ state: 'pending', validUntil: iso(NOW.getTime() + FIRST_CHECK_ALLOWANCE_DAYS * DAY) });
  });

  it('is revoked at once, whatever the dates of the key or the statement', () => {
    const revoked = statement({ status: 'revoked', iat: '2026-12-01T00:00:00.000Z' });
    const state = evaluateLicense(onlineKey(), signer.keys, NOW, { statements: { 'LIC-TEST': revoked } });
    expect(state.status).toBe('revoked');
    expect(state.onlineCheck?.state).toBe('revoked');
    expect(canConfigure(state, 'alerting')).toBe(false);
  });

  it('is active again with a newer active statement (stored in its place)', () => {
    const state = evaluateLicense(onlineKey(), signer.keys, NOW, { statements: { 'LIC-TEST': statement({ iat: '2027-01-09T00:00:00.000Z' }) } });
    expect(state.status).toBe('active');
  });

  it('ignores a statement about another license, signed by an unknown key, or tampered with', () => {
    const firstSeen = NOW.getTime() - 30 * DAY;
    for (const token of [statement({ id: 'LIC-OTHER', status: 'revoked' }), statement({ kid: 'nope' }), `${statement()}x`]) {
      const state = evaluateLicense(onlineKey(), signer.keys, NOW, { statements: { 'LIC-TEST': token }, ...seen(firstSeen) });
      expect(state.status).toBe('unconfirmed');
    }
  });

  it('keeps the dates first: an expired online key stays expired, and grace stays grace when confirmed', () => {
    const expired = evaluateLicense(onlineKey({ exp: '2026-11-01T00:00:00.000Z' }), signer.keys, NOW, { statements: { 'LIC-TEST': statement({ status: 'revoked' }) } });
    expect(expired.status).toBe('expired');
    const grace = evaluateLicense(onlineKey({ exp: '2027-01-05T00:00:00.000Z' }), signer.keys, NOW, { statements: { 'LIC-TEST': statement() } });
    expect(grace.status).toBe('grace');
  });
});

describe('the stored check', () => {
  it('reads garbage as empty and keeps first-seen times once set', () => {
    expect(parseStoredLicenseCheck('nope')).toEqual(EMPTY_LICENSE_CHECK);
    expect(parseStoredLicenseCheck({ statements: { a: 1, b: 's1.x.y' }, firstSeen: { a: 'later', b: '2027-01-01T00:00:00.000Z' } })).toMatchObject({
      statements: { b: 's1.x.y' },
      firstSeen: { b: '2027-01-01T00:00:00.000Z' },
    });
    const once = withFirstSeen(EMPTY_LICENSE_CHECK, 'LIC-TEST', NOW);
    expect(withFirstSeen(once, 'LIC-TEST', new Date(NOW.getTime() + DAY)).firstSeen['LIC-TEST']).toBe(NOW.toISOString());
  });

  it('remembers at most 20 licenses, keeping the current one', () => {
    let check = EMPTY_LICENSE_CHECK;
    for (let i = 0; i < 25; i++) check = withFirstSeen(check, `LIC-${i}`, new Date(NOW.getTime() + i * 1000));
    check = withFirstSeen(check, 'LIC-NEW', new Date(NOW.getTime() - DAY));
    expect(Object.keys(check.firstSeen)).toHaveLength(20);
    expect(check.firstSeen['LIC-NEW']).toBeDefined();
    expect(check.firstSeen['LIC-24']).toBeDefined();
  });
});

describe('isOnlineCheckDue', () => {
  const check = (overrides: Partial<typeof EMPTY_LICENSE_CHECK>) => ({ ...EMPTY_LICENSE_CHECK, ...overrides });

  it('is due without a statement, and when the latest is a day old', () => {
    expect(isOnlineCheckDue(check({}), 'LIC-TEST', NOW)).toBe(true);
    expect(isOnlineCheckDue(check({ statements: { 'LIC-TEST': statement({ iat: iso(NOW.getTime() - 23 * 3_600_000) }) } }), 'LIC-TEST', NOW)).toBe(false);
    expect(isOnlineCheckDue(check({ statements: { 'LIC-TEST': statement({ iat: iso(NOW.getTime() - DAY) }) } }), 'LIC-TEST', NOW)).toBe(true);
  });

  it('waits an hour after an attempt for the same license', () => {
    const lastAttemptAt = iso(NOW.getTime() - ONLINE_CHECK_RETRY_MS + 1000);
    expect(isOnlineCheckDue(check({ licenseId: 'LIC-TEST', lastAttemptAt }), 'LIC-TEST', NOW)).toBe(false);
    expect(isOnlineCheckDue(check({ licenseId: 'LIC-OTHER', lastAttemptAt }), 'LIC-TEST', NOW)).toBe(true);
    expect(isOnlineCheckDue(check({ licenseId: 'LIC-TEST', lastAttemptAt: iso(NOW.getTime() - ONLINE_CHECK_RETRY_MS) }), 'LIC-TEST', NOW)).toBe(true);
  });
});

describe('postLicenseStatus', () => {
  const url = licenseStatusUrl('https://license.example.com', 'LIC-TEST');
  const answer = (body: BodyInit | null, status = 200, headers: Record<string, string> = {}) =>
    vi.fn(async () => new Response(body, { status, headers }));

  it('sends only the key fingerprint, as JSON, without following redirects', async () => {
    const fetchImpl = answer(JSON.stringify({ statement: statement() }));
    const result = await postLicenseStatus(url, keyFingerprint(onlineKey()), fetchImpl as never);
    expect(result).toEqual({ kind: 'ok', statement: statement() });
    const [calledUrl, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe('https://license.example.com/v1/licenses/LIC-TEST/status');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', credentials: 'omit', cache: 'no-store' });
    expect(JSON.parse(String(init.body))).toEqual({ keySha256: keyFingerprint(onlineKey()) });
    expect(keyFingerprint(`  ${onlineKey()}\n`)).toMatch(/^[0-9a-f]{64}$/);
    expect(keyFingerprint(`  ${onlineKey()}\n`)).toBe(keyFingerprint(onlineKey()));
  });

  it.each([
    [404, { kind: 'unknown' }],
    [429, { kind: 'error', error: 'the license server is limiting requests (HTTP 429)' }],
    [503, { kind: 'error', error: 'the license server answered HTTP 503' }],
    [302, { kind: 'error', error: 'the license server answered with a redirect, which is not followed' }],
  ])('maps HTTP %i', async (status, expected) => {
    expect(await postLicenseStatus(url, 'a'.repeat(64), answer(null, status) as never)).toEqual(expected);
  });

  it('reports a network error, a time-out, a body that is not JSON, without a statement or too large', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await postLicenseStatus(url, 'a', down as never)).toEqual({ kind: 'error', error: 'the license server could not be reached' });
    const slow = vi.fn(async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    });
    expect(await postLicenseStatus(url, 'a', slow as never)).toEqual({ kind: 'error', error: 'no answer within 10 seconds' });
    expect(await postLicenseStatus(url, 'a', answer('<html>') as never)).toEqual({ kind: 'error', error: "the license server's answer is not JSON" });
    expect(await postLicenseStatus(url, 'a', answer('{"key":"x"}') as never)).toEqual({
      kind: 'error',
      error: "the license server's answer has no status statement",
    });
    expect(await postLicenseStatus(url, 'a', answer('x'.repeat(20_000)) as never)).toEqual({ kind: 'error', error: "the license server's answer is too large" });
  });
});
