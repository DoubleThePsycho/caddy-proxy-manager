/**
 * The outcome of a request (src/lib/analytics/outcome.ts) and the
 * user-agent family stored with it.
 */
import { describe, expect, it } from 'vitest';
import { deriveOutcome, headerValue, isForwardAuthRedirect, MITIGATED_OUTCOMES, type OutcomeInput } from '@/src/lib/analytics/outcome';
import { userAgentFamily, UA_FAMILY_MAX_LENGTH } from '@/src/lib/analytics/user-agent';

const PORTAL = 'https://ingressi.example.com/portal';

function input(overrides: Partial<OutcomeInput>): OutcomeInput {
  return {
    status: 200,
    blockedByBlocker: false,
    addressRule: false,
    wafBlocked: false,
    requestHost: 'app.example.com',
    portalUrl: PORTAL,
    ...overrides,
  };
}

describe('deriveOutcome', () => {
  it('serves what no rule stopped, whatever the status', () => {
    for (const status of [200, 302, 403, 404, 500, 502]) expect(deriveOutcome(input({ status }))).toBe('served');
  });

  it('counts only Caddy limiter 429s as rate limited', () => {
    expect(deriveOutcome(input({ status: 429, rateLimitZone: 'login' }))).toBe('rate_limit');
    expect(deriveOutcome(input({ status: 429 }))).toBe('served');
    expect(deriveOutcome(input({ status: 429, rateLimitZone: '' }))).toBe('served');
    expect(deriveOutcome(input({ status: 200, rateLimitZone: 'login' }))).toBe('served');
  });

  it('tells geo rules from address rules for caddy-blocker blocks', () => {
    expect(deriveOutcome(input({ status: 403, blockedByBlocker: true }))).toBe('geo');
    expect(deriveOutcome(input({ status: 403, blockedByBlocker: true, addressRule: true }))).toBe('access');
    // A redirect response configured for blocked visitors is still a block.
    expect(deriveOutcome(input({ status: 302, blockedByBlocker: true, respHeaders: { Location: [`${PORTAL}?rd=x`] } }))).toBe('geo');
  });

  it('marks WAF interruptions', () => {
    expect(deriveOutcome(input({ status: 403, wafBlocked: true }))).toBe('waf');
  });

  it('marks Caddy basic-auth refusals as access, not upstream 401s', () => {
    expect(deriveOutcome(input({ status: 401, respHeaders: { 'Www-Authenticate': ['Basic realm="restricted"'] } }))).toBe('access');
    expect(deriveOutcome(input({ status: 401, respHeaders: { 'www-authenticate': ['basic realm="restricted", charset="UTF-8"'] } }))).toBe('access');
    expect(deriveOutcome(input({ status: 401, respHeaders: { 'Www-Authenticate': ['Basic realm="Router"'] } }))).toBe('served');
    expect(deriveOutcome(input({ status: 401, respHeaders: { 'Www-Authenticate': ['Bearer'] } }))).toBe('served');
    expect(deriveOutcome(input({ status: 401 }))).toBe('served');
  });

  it('marks forward-auth sign-in redirects as auth', () => {
    const redirect = (location: string, status = 302) => deriveOutcome(input({ status, respHeaders: { Location: [location] } }));
    expect(redirect(`${PORTAL}?rd=https%3A%2F%2Fapp.example.com%2F`)).toBe('auth');
    expect(redirect('/outpost.goauthentik.io/start?rd=https%3A%2F%2Fapp.example.com%2F')).toBe('auth');
    expect(redirect('https://auth.example.org/?rd=https%3A%2F%2Fapp.example.com%2Fadmin', 303)).toBe('auth');
    expect(redirect('/oauth2/start?rd=%2Fadmin')).toBe('auth');
    // Ordinary redirects stay served.
    expect(redirect('https://app.example.com/login')).toBe('served');
    expect(redirect('https://www.example.com/')).toBe('served');
    expect(redirect('https://auth.example.org/?rd=https%3A%2F%2Fother.example.com%2F')).toBe('served');
    expect(redirect('https://evil.example.org/portal?rd=x')).toBe('served');
    expect(redirect('/oauth2/start?rd=%2F', 200)).toBe('served');
  });

  it('only calls served unmitigated', () => {
    expect(MITIGATED_OUTCOMES).toEqual(['waf', 'geo', 'access', 'auth', 'rate_limit']);
  });
});

describe('isForwardAuthRedirect', () => {
  it('ignores the port of the request host and malformed URLs', () => {
    expect(isForwardAuthRedirect('https://sso.example.org/?rd=https://app.example.com:8443/x', 'app.example.com:8443', null)).toBe(true);
    expect(isForwardAuthRedirect('http://[::1', 'app.example.com', PORTAL)).toBe(false);
    expect(isForwardAuthRedirect(`${PORTAL}?rd=x`, 'app.example.com', 'not a url')).toBe(false);
  });
});

describe('headerValue', () => {
  it('reads the first value case-insensitively', () => {
    expect(headerValue({ Location: ['/a', '/b'] }, 'location')).toBe('/a');
    expect(headerValue({ location: '/c' }, 'Location')).toBe('/c');
    expect(headerValue(null, 'Location')).toBeNull();
    expect(headerValue(['x'], 'Location')).toBeNull();
  });
});

describe('userAgentFamily', () => {
  it.each([
    ['', '(none)'],
    [null, '(none)'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', 'Chrome · Windows'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15', 'Safari · macOS'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'Safari · iOS'],
    ['Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36', 'Chrome · Android'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Firefox · Linux'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0', 'Edge · Windows'],
    ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Googlebot 2.1'],
    ['Uptime-Kuma/2.5.5', 'Uptime-Kuma 2.5.5'],
    ['Go-http-client/1.1', 'Go-http-client 1.1'],
    ['curl/8.5.0', 'curl 8.5.0'],
    ['python-requests/2.31.0.post1', 'python-requests 2.31.0'],
    ['OTel-OTLP-Exporter-Python/1.45.0', 'OTel exporter · Python 1.45'],
    ['Apple-iPhone14C5/2101.329', 'iPhone Mail'],
    ['l9explore/1.2.2', 'l9explore 1.2.2'],
    ['Infuse-Direct/8.5.6 (iPhone)', 'Infuse-Direct 8.5.6'],
    ['something-odd without version', 'something-odd'],
  ])('%s → %s', (ua, family) => {
    expect(userAgentFamily(ua)).toBe(family);
  });

  it('caps the length and strips control characters', () => {
    expect(userAgentFamily(`${'a'.repeat(200)}/1.0`).length).toBeLessThanOrEqual(UA_FAMILY_MAX_LENGTH);
    expect(userAgentFamily('curl/8.5.0\u0000\n')).toBe('curl 8.5.0');
  });
});
