/**
 * Rate limiting input validation (src/lib/caddy-rate-limit.ts): every field
 * of a rule, the host block and the global defaults is checked strictly, so
 * nothing free-form reaches the Caddy configuration, and stored values that
 * no longer validate are dropped one by one rather than failing the build.
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeProxyHostRateLimit,
  normalizeRateLimitRule,
  normalizeRateLimitRules,
  normalizeRateLimitSettings,
  readStoredHostRateLimit,
  readStoredRateLimitSettings,
} from '@/src/lib/caddy-rate-limit';
import { ApiValidationError } from '@/src/lib/api-errors';
import { SettingsValidationError, validateSettingsGroup } from '@/src/lib/settings-validation';
import { isValidRateLimitPath, rateLimitWindowSeconds, describeRateLimitRule } from '@/src/lib/rate-limit-rules';

const rule = (overrides: Record<string, unknown> = {}) => ({ path: '/login', methods: ['post'], events: 5, window: '1m', ...overrides });

describe('normalizeRateLimitRule', () => {
  it('fills the defaults and normalizes methods', () => {
    expect(normalizeRateLimitRule({ events: 10, window: '30s' }, 'r')).toEqual({
      path: '*', methods: [], key: 'client_ip', events: 10, window: '30s',
    });
    expect(normalizeRateLimitRule(rule({ methods: ['post', 'GET', 'get'] }), 'r').methods).toEqual(['GET', 'POST']);
    expect(normalizeRateLimitRule(rule({ path: '  ' }), 'r').path).toBe('*');
  });

  it('keeps the header only on header keys', () => {
    expect(normalizeRateLimitRule(rule({ key: 'header', header: ' X-Api-Key ' }), 'r')).toMatchObject({ key: 'header', header: 'X-Api-Key' });
    expect(normalizeRateLimitRule(rule({ key: 'client_ip', header: '' }), 'r')).not.toHaveProperty('header');
    expect(() => normalizeRateLimitRule(rule({ key: 'client_ip', header: 'X-Api-Key' }), 'r')).toThrow(/only allowed when key is "header"/);
    expect(() => normalizeRateLimitRule(rule({ key: 'header' }), 'r')).toThrow(/header is required/);
  });

  it.each([
    ['a placeholder', '/api/{http.request.header.X-Bucket}'],
    ['a space', '/my path'],
    ['no leading slash', 'login'],
    ['a bracket glob', '/files/[a-z]*'],
    ['a backslash', '/a\\b'],
    ['a malformed escape', '/a%zz'],
    ['a newline', '/a\n/b'],
    ['a query string', '/search?q=1'],
    ['too long', `/${'a'.repeat(256)}`],
  ])('refuses a path with %s', (_label, path) => {
    expect(() => normalizeRateLimitRule(rule({ path }), 'rules[0]')).toThrow(ApiValidationError);
    expect(() => normalizeRateLimitRule(rule({ path }), 'rules[0]')).toThrow(/rules\[0\]\.path/);
  });

  it('accepts Caddy path patterns', () => {
    for (const path of ['*', '/', '/login', '/api/*', '*/admin', '*.php', '/.well-known/acme-challenge/*', '/a%20b', "/x;y=1/@me~!$&'()+,"]) {
      expect(isValidRateLimitPath(path), path).toBe(true);
    }
  });

  it.each([
    ['X-Api-Key{x}', /valid HTTP header name/],
    ['X Api Key', /valid HTTP header name/],
    ['X-Api-Key\r\nX-Evil: 1', /valid HTTP header name/],
    [`X-${'a'.repeat(127)}`, /valid HTTP header name/],
    ['X-Ingressi-User-Id', /forward auth or Ingressi itself/],
    ['x_ingressi_user', /forward auth or Ingressi itself/],
    ['X-Ingressi-Consumer-Id', /forward auth or Ingressi itself/],
  ])('refuses the header name %j', (header, message) => {
    expect(() => normalizeRateLimitRule(rule({ key: 'header', header }), 'r')).toThrow(message);
  });

  it('refuses unknown methods, keys and fields', () => {
    expect(() => normalizeRateLimitRule(rule({ methods: ['PROPFIND'] }), 'r')).toThrow(/r\.methods\[0\]/);
    expect(() => normalizeRateLimitRule(rule({ methods: 'GET' }), 'r')).toThrow(/methods must be an array/);
    expect(() => normalizeRateLimitRule(rule({ key: 'cookie' }), 'r')).toThrow(/r\.key/);
    expect(() => normalizeRateLimitRule(rule({ burst: 3 }), 'r')).toThrow(/unknown field: burst/);
    expect(() => normalizeRateLimitRule('GET /login 5/m', 'r')).toThrow(/must be an object/);
  });

  it.each([0, -1, 1.5, 1001, '5', null])('refuses %j events', (events) => {
    expect(() => normalizeRateLimitRule(rule({ events }), 'r')).toThrow(/events must be an integer from 1 to 1000/);
  });

  it.each(['0s', '1d', '1.5m', '61m', '3601s', '2h', 'm', '1 m', '01m', 60, ''])('refuses the window %j', (window) => {
    expect(() => normalizeRateLimitRule(rule({ window }), 'r')).toThrow(/window/);
  });

  it('accepts windows from one second to one hour', () => {
    expect(rateLimitWindowSeconds('1s')).toBe(1);
    expect(rateLimitWindowSeconds('90s')).toBe(90);
    expect(rateLimitWindowSeconds('60m')).toBe(3600);
    expect(rateLimitWindowSeconds('3600s')).toBe(3600);
    expect(rateLimitWindowSeconds('1h')).toBe(3600);
    expect(normalizeRateLimitRule(rule({ window: ' 5m ' }), 'r').window).toBe('5m');
  });

  it('describes a rule for people', () => {
    expect(describeRateLimitRule(normalizeRateLimitRule(rule(), 'r'))).toBe('5 per 1m per client ip on /login (POST)');
  });
});

describe('normalizeRateLimitRules', () => {
  it('refuses repeats and more than 20 rules', () => {
    expect(() => normalizeRateLimitRules([rule(), rule({ methods: ['POST'] })], 'rules')).toThrow(/rules\[1\] repeats rules\[0\]/);
    expect(() => normalizeRateLimitRules(Array.from({ length: 21 }, (_, i) => rule({ events: i + 1 })), 'rules')).toThrow(/at most 20/);
    expect(normalizeRateLimitRules(null, 'rules')).toEqual([]);
    expect(() => normalizeRateLimitRules({}, 'rules')).toThrow(/must be an array/);
  });

  it('allows the same path with different limits (burst and sustained)', () => {
    expect(normalizeRateLimitRules([rule({ events: 5, window: '1s' }), rule({ events: 100, window: '1m' })], 'rules')).toHaveLength(2);
  });
});

describe('normalizeProxyHostRateLimit', () => {
  it('defaults to enabled merge mode', () => {
    expect(normalizeProxyHostRateLimit({ rules: [rule()] })).toEqual({
      enabled: true,
      mode: 'merge',
      rules: [{ path: '/login', methods: ['POST'], key: 'client_ip', events: 5, window: '1m' }],
    });
  });

  it('refuses a bad mode, enabled flag or field', () => {
    expect(() => normalizeProxyHostRateLimit({ mode: 'replace' })).toThrow(/rateLimit\.mode/);
    expect(() => normalizeProxyHostRateLimit({ enabled: 'yes' })).toThrow(/rateLimit\.enabled/);
    expect(() => normalizeProxyHostRateLimit({ allowlist: [] })).toThrow(/unknown field: allowlist/);
    expect(() => normalizeProxyHostRateLimit([])).toThrow(/must be an object/);
  });
});

describe('normalizeRateLimitSettings', () => {
  it('normalizes the allowlist and keeps the IPv6 prefix', () => {
    expect(normalizeRateLimitSettings({
      enabled: true,
      rules: [rule()],
      allowlist: [' 192.0.2.10 ', '198.51.100.0/24', '2001:db8::/48', 'private_ranges', '192.0.2.10'],
      ipv6Prefix: 56,
    })).toEqual({
      enabled: true,
      rules: [{ path: '/login', methods: ['POST'], key: 'client_ip', events: 5, window: '1m' }],
      allowlist: ['192.0.2.10', '198.51.100.0/24', '2001:db8::/48', 'private_ranges'],
      ipv6Prefix: 56,
    });
    expect(normalizeRateLimitSettings({ enabled: false })).toEqual({ enabled: false, rules: [], allowlist: [] });
  });

  it.each(['example.com', '10.0.0.0/33', '10.0.0.0/08', '2001:db8::/129', 'fe80::1%eth0', '10.0.0.1/', ''])(
    'refuses the allowlist entry %j',
    (entry) => {
      expect(() => normalizeRateLimitSettings({ enabled: true, allowlist: [entry] })).toThrow(/allowlist\[0\]/);
    }
  );

  it('refuses a missing enabled flag, a bad IPv6 prefix and unknown fields', () => {
    expect(() => normalizeRateLimitSettings({ rules: [] })).toThrow(/enabled must be a boolean/);
    expect(() => normalizeRateLimitSettings({ enabled: true, ipv6Prefix: 16 })).toThrow(/ipv6Prefix/);
    expect(() => normalizeRateLimitSettings({ enabled: true, ipv6Prefix: 64.5 })).toThrow(/ipv6Prefix/);
    expect(() => normalizeRateLimitSettings({ enabled: true, mode: 'merge' })).toThrow(/unknown field: mode/);
    expect(() => normalizeRateLimitSettings({ enabled: true, allowlist: Array(257).fill('192.0.2.1') })).toThrow(/at most 256/);
  });

  it('backs the REST settings group with the same rules', () => {
    const valid = { enabled: true, rules: [rule()], allowlist: ['192.0.2.0/24'], ipv6Prefix: 64 };
    expect(validateSettingsGroup('rate-limit', valid)).toBe(valid);
    expect(() => validateSettingsGroup('rate-limit', { ...valid, extra: 1 })).toThrow(SettingsValidationError);
    expect(() => validateSettingsGroup('rate-limit', { ...valid, rules: [rule({ window: '1d' })] })).toThrow(/rate-limit\.rules\[0\]\.window/);
  });
});

describe('stored values', () => {
  it('drops only the invalid stored rules of a host', () => {
    expect(readStoredHostRateLimit({
      enabled: true,
      mode: 'override',
      rules: [rule(), rule({ path: '/{http.request.host}' }), rule()],
    })).toEqual({
      enabled: true,
      mode: 'override',
      rules: [{ path: '/login', methods: ['POST'], key: 'client_ip', events: 5, window: '1m' }],
    });
    expect(readStoredHostRateLimit('nonsense')).toBeNull();
    expect(readStoredHostRateLimit({ mode: 'weird', rules: 'x' })).toEqual({ enabled: false, mode: 'merge', rules: [] });
  });

  it('drops invalid stored allowlist entries and prefixes', () => {
    expect(readStoredRateLimitSettings({ enabled: true, rules: [], allowlist: ['192.0.2.1', 'not-an-ip', 7], ipv6Prefix: 3 })).toEqual({
      enabled: true,
      rules: [],
      allowlist: ['192.0.2.1'],
    });
    expect(readStoredRateLimitSettings(null)).toBeNull();
  });
});
