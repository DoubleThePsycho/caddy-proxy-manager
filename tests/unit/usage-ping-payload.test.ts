/**
 * The usage ping's pure parts: the payload builder (exact fields, buckets,
 * editions, nothing else can get in), the environment switches, the daily
 * schedule with its jitter, and one send with a mocked fetch.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildUsagePingPayload,
  bucketCount,
  COUNT_BUCKETS,
  FEATURE_FIELDS,
  isUuidV4,
  normalizeArch,
  normalizeVersion,
  PAID_FEATURES,
  USAGE_PING_EDITIONS,
  type UsagePingFacts,
} from '@/src/lib/usage-ping/payload';
import {
  DEFAULT_USAGE_PING_URL,
  isUsagePingDisabledByEnv,
  isUsagePingEnabledByEnv,
  resolveUsagePingEndpoint,
} from '@/src/lib/usage-ping/env';
import {
  FIRST_PING_DELAY_MS,
  firstAttemptAfterOptIn,
  MIN_ATTEMPT_SPACING_MS,
  nextDailyAttempt,
  randomMinuteOfDay,
} from '@/src/lib/usage-ping/schedule';
import { sendUsagePing, USAGE_PING_TIMEOUT_MS } from '@/src/lib/usage-ping/scheduler';
import { FEATURES, FEATURE_INFO, EDITIONS } from '@/ee/licensing/features';

const INSTALL_ID = '0b6f3c1e-2a4d-4f8e-9c3b-5d7e1f2a3b4c';

function facts(overrides: Partial<UsagePingFacts> = {}): UsagePingFacts {
  return {
    version: '2.0.0',
    edition: 'community',
    role: 'standalone',
    counts: { proxy_hosts: 7, l4_hosts: 0, users: 2, replicas: 0 },
    features: Object.fromEntries(FEATURE_FIELDS.map((field) => [field, false])) as UsagePingFacts['features'],
    arch: 'x64',
    ...overrides,
  };
}

describe('payload', () => {
  it('has exactly the documented fields, in a fixed order', () => {
    const payload = buildUsagePingPayload(INSTALL_ID, facts());
    expect(Object.keys(payload)).toEqual(['schema', 'install_id', 'version', 'edition', 'role', 'counts', 'features', 'arch']);
    expect(Object.keys(payload.counts)).toEqual(['proxy_hosts', 'l4_hosts', 'users', 'replicas']);
    expect(Object.keys(payload.features)).toEqual([...FEATURE_FIELDS]);
    expect(payload).toMatchObject({ schema: 1, install_id: INSTALL_ID, version: '2.0.0', edition: 'community', role: 'standalone', arch: 'x64' });
    expect(payload.counts).toEqual({ proxy_hosts: '6-20', l4_hosts: '0', users: '1-5', replicas: '0' });
  });

  it('drops anything in the facts beyond the documented fields', () => {
    const leaky = {
      ...facts(),
      hostname: 'app.example.com',
      email: 'admin@example.com',
      licenseId: 'lic_123',
      customer: 'Example Corp',
      counts: { proxy_hosts: 1, l4_hosts: 1, users: 1, replicas: 0, domains: 4 },
      features: { ...facts().features, waf: true, secret_feature: true },
    } as unknown as UsagePingFacts;
    const payload = buildUsagePingPayload(INSTALL_ID, leaky);
    const body = JSON.stringify(payload);
    for (const forbidden of ['app.example.com', 'admin@example.com', 'lic_123', 'Example Corp', 'domains', 'secret_feature', 'hostname']) {
      expect(body).not.toContain(forbidden);
    }
    expect(payload.features.waf).toBe(true);
  });

  it('buckets counts and never sends a number', () => {
    const cases: Array<[number, string]> = [
      [0, '0'], [-3, '0'], [Number.NaN, '0'], [1, '1-5'], [5, '1-5'], [6, '6-20'], [20, '6-20'],
      [21, '21-100'], [100, '21-100'], [101, '101+'], [50_000, '101+'],
    ];
    for (const [count, bucket] of cases) expect(bucketCount(count), String(count)).toBe(bucket);
    const payload = buildUsagePingPayload(INSTALL_ID, facts({ role: 'master', counts: { proxy_hosts: 250, l4_hosts: 3, users: 40, replicas: 2 } }));
    expect(payload.counts).toEqual({ proxy_hosts: '101+', l4_hosts: '1-5', users: '21-100', replicas: '1-5' });
    for (const value of Object.values(payload.counts)) expect(COUNT_BUCKETS).toContain(value);
  });

  it('sends no replicas for a standalone install and only the two sending roles', () => {
    expect(buildUsagePingPayload(INSTALL_ID, facts({ counts: { proxy_hosts: 0, l4_hosts: 0, users: 1, replicas: 9 } })).counts.replicas).toBe('0');
    expect(buildUsagePingPayload(INSTALL_ID, facts({ role: 'slave' as never })).role).toBe('standalone');
  });

  it('sends the licensed edition name or community, nothing else', () => {
    expect(USAGE_PING_EDITIONS).toEqual(['community', ...EDITIONS]);
    for (const edition of USAGE_PING_EDITIONS) {
      expect(buildUsagePingPayload(INSTALL_ID, facts({ edition })).edition).toBe(edition);
    }
    expect(buildUsagePingPayload(INSTALL_ID, facts({ edition: 'lic_abc / Example Corp' as never })).edition).toBe('community');
  });

  it('normalises the version and the architecture', () => {
    expect(normalizeVersion('2.0.0')).toBe('2.0.0');
    expect(normalizeVersion('v1.13.1')).toBe('v1.13.1');
    expect(normalizeVersion('927144e6')).toBe('927144e6');
    expect(normalizeVersion('build for app.example.com by admin@example.com')).toBe('unknown');
    expect(normalizeVersion('x'.repeat(41))).toBe('unknown');
    expect(normalizeVersion('')).toBe('unknown');
    expect(normalizeArch('arm64')).toBe('arm64');
    expect(normalizeArch('mips64el')).toBe('other');
  });

  it('lists only paid features that exist and have shipped', () => {
    for (const feature of PAID_FEATURES) {
      expect(FEATURES).toContain(feature);
      expect(FEATURE_INFO[feature].available, feature).toBe(true);
    }
  });

  it('stays far below the receiver limit of 4 KiB', () => {
    const all = Object.fromEntries(FEATURE_FIELDS.map((field) => [field, true])) as UsagePingFacts['features'];
    const payload = buildUsagePingPayload(INSTALL_ID, facts({ version: 'x'.repeat(40), edition: 'enterprise', role: 'master', features: all, arch: 'riscv64' }));
    expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeLessThan(1500);
  });

  it('recognises UUID v4 install ids only', () => {
    expect(isUuidV4(INSTALL_ID)).toBe(true);
    expect(isUuidV4(INSTALL_ID.toUpperCase())).toBe(false);
    expect(isUuidV4('0b6f3c1e-2a4d-1f8e-9c3b-5d7e1f2a3b4c')).toBe(false);
    expect(isUuidV4(42)).toBe(false);
  });
});

describe('environment switches', () => {
  it('USAGE_PING_DISABLED: set means off, unless empty or an explicit no', () => {
    expect(isUsagePingDisabledByEnv({})).toBe(false);
    for (const value of ['', 'false', 'FALSE', '0', 'no', 'off', ' false ']) {
      expect(isUsagePingDisabledByEnv({ USAGE_PING_DISABLED: value }), value).toBe(false);
    }
    for (const value of ['true', 'TRUE', '1', 'yes', 'on', 'ture']) {
      expect(isUsagePingDisabledByEnv({ USAGE_PING_DISABLED: value }), value).toBe(true);
    }
  });

  it('USAGE_PING_ENABLED: only an explicit yes counts', () => {
    expect(isUsagePingEnabledByEnv({})).toBe(false);
    for (const value of ['true', 'TRUE', '1', 'yes', 'on', ' true ']) {
      expect(isUsagePingEnabledByEnv({ USAGE_PING_ENABLED: value }), value).toBe(true);
    }
    for (const value of ['', 'false', '0', 'no', 'off', 'ture', 'enabled', 'y']) {
      expect(isUsagePingEnabledByEnv({ USAGE_PING_ENABLED: value }), value).toBe(false);
    }
  });

  it('USAGE_PING_URL: https only, no credentials, never a silent fallback', () => {
    expect(resolveUsagePingEndpoint({})).toEqual({ url: DEFAULT_USAGE_PING_URL, error: null });
    expect(DEFAULT_USAGE_PING_URL).toBe('https://ping.ingres.si/v1/ping');
    expect(resolveUsagePingEndpoint({ USAGE_PING_URL: '  ' })).toEqual({ url: DEFAULT_USAGE_PING_URL, error: null });
    expect(resolveUsagePingEndpoint({ USAGE_PING_URL: 'https://ping.example.com/v1/ping' })).toEqual({
      url: 'https://ping.example.com/v1/ping',
      error: null,
    });
    for (const bad of ['http://ping.example.com/v1/ping', 'ftp://ping.example.com', 'not a url', 'https://user:pass@ping.example.com/']) {
      const endpoint = resolveUsagePingEndpoint({ USAGE_PING_URL: bad });
      expect(endpoint.url, bad).toBeNull();
      expect(endpoint.error, bad).toMatch(/USAGE_PING_URL/);
    }
  });
});

describe('schedule', () => {
  it('picks a random minute of the day', () => {
    const minutes = new Set(Array.from({ length: 200 }, () => randomMinuteOfDay()));
    for (const minute of minutes) expect(minute >= 0 && minute < 1440 && Number.isInteger(minute)).toBe(true);
    expect(minutes.size).toBeGreaterThan(50);
  });

  it('sends the first ping one to five minutes after opting in', () => {
    const now = new Date('2026-10-03T10:00:00.000Z');
    const delays = new Set<number>();
    for (let i = 0; i < 100; i++) {
      const delay = firstAttemptAfterOptIn(now).getTime() - now.getTime();
      expect(delay).toBeGreaterThanOrEqual(FIRST_PING_DELAY_MS.min);
      expect(delay).toBeLessThanOrEqual(FIRST_PING_DELAY_MS.max);
      delays.add(delay);
    }
    expect(delays.size).toBeGreaterThan(10);
  });

  it('then once a day at the install minute, at least 12 hours after the previous attempt', () => {
    const minute = 10 * 60 + 30; // 10:30 UTC
    expect(nextDailyAttempt(minute, new Date('2026-10-03T10:30:00.000Z')).toISOString()).toBe('2026-10-04T10:30:00.000Z');
    expect(nextDailyAttempt(minute, new Date('2026-10-03T10:03:00.000Z')).toISOString()).toBe('2026-10-04T10:30:00.000Z');
    expect(nextDailyAttempt(minute, new Date('2026-10-03T23:00:00.000Z')).toISOString()).toBe('2026-10-05T10:30:00.000Z');
    expect(nextDailyAttempt(minute, new Date('2026-10-02T22:30:00.000Z')).toISOString()).toBe('2026-10-03T10:30:00.000Z');
    for (let i = 0; i < 50; i++) {
      const after = new Date(Date.UTC(2026, 9, 3) + Math.floor(Math.random() * 86_400_000));
      const next = nextDailyAttempt(minute, after).getTime() - after.getTime();
      expect(next).toBeGreaterThanOrEqual(MIN_ATTEMPT_SPACING_MS);
      expect(next).toBeLessThan(MIN_ATTEMPT_SPACING_MS + 86_400_000);
    }
  });
});

describe('sendUsagePing', () => {
  const payload = buildUsagePingPayload(INSTALL_ID, facts());

  it('posts the JSON once, without following redirects and with a 10 s limit', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    expect(await sendUsagePing('https://ping.example.com/v1/ping', payload, fetchMock as never)).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ping.example.com/v1/ping');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.credentials).toBe('omit');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual(payload);
    expect(USAGE_PING_TIMEOUT_MS).toBe(10_000);
  });

  it('reports redirects, errors, network failures and time-outs without throwing', async () => {
    const answer = (status: number) => vi.fn(async () => new Response(null, { status, headers: status === 302 ? { location: 'https://elsewhere.example.com/' } : {} }));
    expect(await sendUsagePing('https://ping.example.com/', payload, answer(302) as never)).toEqual({ ok: false, error: expect.stringMatching(/redirect/) });
    expect(await sendUsagePing('https://ping.example.com/', payload, answer(500) as never)).toEqual({ ok: false, error: 'the endpoint answered HTTP 500' });
    expect(await sendUsagePing('https://ping.example.com/', payload, answer(400) as never)).toEqual({ ok: false, error: 'the endpoint answered HTTP 400' });
    const offline = vi.fn(async () => { throw new TypeError('fetch failed'); });
    expect(await sendUsagePing('https://ping.example.com/', payload, offline as never)).toEqual({ ok: false, error: 'the endpoint could not be reached' });
    const slow = vi.fn(async () => { throw new DOMException('The operation timed out.', 'TimeoutError'); });
    expect(await sendUsagePing('https://ping.example.com/', payload, slow as never)).toEqual({ ok: false, error: 'no answer within 10 seconds' });
  });
});
