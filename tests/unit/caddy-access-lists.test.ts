/**
 * The Caddy JSON of access list rules (src/lib/caddy-access-lists.ts): first
 * match decides, with address rules as client_ip/remote_ip matchers and
 * country, continent and AS number rules as caddy-blocker handlers; earlier
 * allows exempt clients from later denies; the default action; the deny
 * response; fail closed; the access log marker.
 */
import { describe, expect, it } from 'vitest';
import {
  BLOCKED_SOURCES_LOG_VALUE,
  GEOIP_ASN_DB,
  GEOIP_COUNTRY_DB,
  buildAccessListHandler,
  buildAccessListRoutes,
  type CompiledAccessList,
  type CompiledAccessListRule,
} from '@/src/lib/caddy-access-lists';
import { PRIVATE_RANGES_CIDRS } from '@/src/lib/caddy-utils';

const NO_PROXIES = { trustedProxies: [] as string[] };
const PROXIES = { trustedProxies: ['10.0.0.0/8'] };

function list(rules: CompiledAccessListRule[], overrides: Partial<CompiledAccessList> = {}): CompiledAccessList {
  return {
    logValue: '7',
    rules,
    defaultAction: 'allow',
    denyStatus: 403,
    denyBody: null,
    denyRedirectUrl: null,
    failClosed: false,
    ...overrides,
  };
}

const allowIp = (...values: string[]): CompiledAccessListRule => ({ action: 'allow', kind: 'ip', values });
const denyIp = (...values: string[]): CompiledAccessListRule => ({ action: 'deny', kind: 'ip', values });
const allowCountry = (...values: string[]): CompiledAccessListRule => ({ action: 'allow', kind: 'country', values });
const denyCountry = (...values: string[]): CompiledAccessListRule => ({ action: 'deny', kind: 'country', values });

const STATIC_DENY = [
  { handler: 'log_append', key: 'access_list', value: '7' },
  { handler: 'static_response', status_code: 403, body: 'Forbidden' },
];

function blocker(fields: Record<string, unknown>) {
  return {
    handler: 'blocker',
    geoip_db: GEOIP_COUNTRY_DB,
    asn_db: GEOIP_ASN_DB,
    response_status: 403,
    response_body: 'Forbidden',
    ...fields,
  };
}

describe('buildAccessListRoutes', () => {
  it('emits nothing for a list that lets everyone through', () => {
    expect(buildAccessListRoutes(list([]), NO_PROXIES)).toEqual([]);
    expect(buildAccessListRoutes(list([allowIp('10.0.0.0/8'), allowCountry('IT')]), NO_PROXIES)).toEqual([]);
    expect(buildAccessListHandler(list([]), NO_PROXIES)).toBeNull();
  });

  it('denies an address with remote_ip without trusted proxies, and client_ip with them', () => {
    expect(buildAccessListRoutes(list([denyIp('198.51.100.19')]), NO_PROXIES)).toEqual([
      { match: [{ remote_ip: { ranges: ['198.51.100.19'] } }], handle: STATIC_DENY },
    ]);
    expect(buildAccessListRoutes(list([denyIp('2001:db8:bad::/48')]), PROXIES)).toEqual([
      { match: [{ client_ip: { ranges: ['2001:db8:bad::/48'] } }], handle: STATIC_DENY },
    ]);
  });

  it('lets an earlier allow win over a later deny of an overlapping network', () => {
    expect(buildAccessListRoutes(list([allowIp('10.1.0.0/16'), denyIp('10.0.0.0/8')]), NO_PROXIES)).toEqual([
      {
        match: [{ remote_ip: { ranges: ['10.0.0.0/8'] }, not: [{ remote_ip: { ranges: ['10.1.0.0/16'] } }] }],
        handle: STATIC_DENY,
      },
    ]);
  });

  it('lets an earlier deny win over a later allow: the allow does not exempt it', () => {
    expect(buildAccessListRoutes(list([denyIp('10.0.0.0/8'), allowIp('10.1.0.0/16')]), NO_PROXIES)).toEqual([
      { match: [{ remote_ip: { ranges: ['10.0.0.0/8'] } }], handle: STATIC_DENY },
    ]);
  });

  it('denies whoever no allow covers when the default is deny', () => {
    expect(buildAccessListRoutes(list([allowIp('203.0.113.0/26'), allowIp('10.13.13.0/24')], { defaultAction: 'deny' }), PROXIES)).toEqual([
      { match: [{ not: [{ client_ip: { ranges: ['203.0.113.0/26', '10.13.13.0/24'] } }] }], handle: STATIC_DENY },
    ]);
    // With no rules at all, everyone is denied.
    expect(buildAccessListRoutes(list([], { defaultAction: 'deny' }), NO_PROXIES)).toEqual([{ handle: STATIC_DENY }]);
  });

  it('merges consecutive denies of one family into one route', () => {
    const routes = buildAccessListRoutes(list([denyIp('198.51.100.19'), denyIp('203.0.113.140', '198.51.100.19'), denyCountry('KP'), { action: 'deny', kind: 'asn', values: ['64500'] }]), NO_PROXIES);
    expect(routes).toEqual([
      { match: [{ remote_ip: { ranges: ['198.51.100.19', '203.0.113.140'] } }], handle: STATIC_DENY },
      { handle: [blocker({ block_countries: ['KP'], block_asns: [64500] })] },
    ]);
  });

  it('denies countries, continents and AS numbers with caddy-blocker, exempting earlier address allows', () => {
    const routes = buildAccessListRoutes(
      list([allowIp('192.0.2.10'), denyCountry('CN', 'RU'), { action: 'deny', kind: 'continent', values: ['AF'] }]),
      PROXIES
    );
    expect(routes).toEqual([
      {
        match: [{ not: [{ client_ip: { ranges: ['192.0.2.10'] } }] }],
        handle: [blocker({ block_countries: ['CN', 'RU'], block_continents: ['AF'], trusted_proxies: ['10.0.0.0/8'] })],
      },
    ]);
  });

  it('lets an earlier country allow exempt clients from a later address deny', () => {
    // Allow Italy, then deny everyone else's 0.0.0.0/0: the address matcher
    // finds the clients, the blocker lets Italy through and blocks the rest,
    // and an address it cannot attribute is denied (the rule matched).
    expect(buildAccessListRoutes(list([allowCountry('IT'), denyIp('0.0.0.0/0', '::/0')]), NO_PROXIES)).toEqual([
      {
        match: [{ remote_ip: { ranges: ['0.0.0.0/0', '::/0'] } }],
        handle: [blocker({ allow_countries: ['IT'], block_cidrs: ['0.0.0.0/0', '::/0'], fail_closed: true })],
      },
    ]);
  });

  it('builds the EU-only list: Europe and private networks, everyone else denied', () => {
    const routes = buildAccessListRoutes(
      list([{ action: 'allow', kind: 'continent', values: ['EU'] }, allowIp('private_ranges')], { defaultAction: 'deny' }),
      NO_PROXIES
    );
    expect(routes).toEqual([
      {
        match: [{ not: [{ remote_ip: { ranges: PRIVATE_RANGES_CIDRS } }] }],
        handle: [blocker({ allow_continents: ['EU'], block_cidrs: ['0.0.0.0/0', '::/0'], fail_closed: true })],
      },
    ]);
  });

  it('keeps earlier country allows on later country denies only', () => {
    const routes = buildAccessListRoutes(list([denyCountry('CN'), allowCountry('HK'), denyCountry('HK', 'TW')]), NO_PROXIES);
    expect(routes).toEqual([
      { handle: [blocker({ block_countries: ['CN'] })] },
      { handle: [blocker({ block_countries: ['HK', 'TW'], allow_countries: ['HK'] })] },
    ]);
  });

  it('serves the custom status and body, escaping host placeholders in static responses', () => {
    const routes = buildAccessListRoutes(list([denyIp('198.51.100.19'), denyCountry('KP')], { denyStatus: 451, denyBody: 'Gone {env.SECRET}' }), NO_PROXIES);
    expect(routes[0].handle).toEqual([
      { handler: 'log_append', key: 'access_list', value: '7' },
      { handler: 'static_response', status_code: 451, body: 'Gone \\{env.SECRET}' },
    ]);
    // caddy-blocker writes its body as is (no placeholders).
    expect(routes[1].handle).toEqual([blocker({ block_countries: ['KP'], response_status: 451, response_body: 'Gone {env.SECRET}' })]);
  });

  it('redirects instead when a redirect URL is set', () => {
    const routes = buildAccessListRoutes(list([denyIp('198.51.100.19'), denyCountry('KP')], { denyRedirectUrl: 'https://example.com/not-available' }), NO_PROXIES);
    expect(routes[0].handle).toEqual([
      { handler: 'log_append', key: 'access_list', value: '7' },
      { handler: 'static_response', status_code: 302, headers: { Location: ['https://example.com/not-available'] } },
    ]);
    const handler = (routes[1].handle as Record<string, unknown>[])[0];
    expect(handler.redirect_url).toBe('https://example.com/not-available');
    expect(handler).not.toHaveProperty('response_status');
  });

  it('blocks unknown clients first when fail closed is on behind trusted proxies', () => {
    const routes = buildAccessListRoutes(list([denyCountry('KP')], { failClosed: true }), PROXIES);
    expect(routes[0]).toEqual({ handle: [blocker({ trusted_proxies: ['10.0.0.0/8'], fail_closed: true })] });
    expect(routes).toHaveLength(2);
    // Without trusted proxies the client address is always known: nothing to add.
    expect(buildAccessListRoutes(list([denyCountry('KP')], { failClosed: true }), NO_PROXIES)).toHaveLength(1);
    // A list that does nothing stays empty.
    expect(buildAccessListRoutes(list([], { failClosed: true }), PROXIES)).toEqual([]);
  });

  it('marks the Blocked sources list in the access log', () => {
    const routes = buildAccessListRoutes(list([denyIp('198.51.100.19')], { logValue: BLOCKED_SOURCES_LOG_VALUE }), NO_PROXIES);
    expect((routes[0].handle as Record<string, unknown>[])[0]).toEqual({ handler: 'log_append', key: 'access_list', value: 'blocked_sources' });
  });

  it('wraps the routes in one subroute handler', () => {
    expect(buildAccessListHandler(list([denyIp('198.51.100.19')]), NO_PROXIES)).toEqual({
      handler: 'subroute',
      routes: [{ match: [{ remote_ip: { ranges: ['198.51.100.19'] } }], handle: STATIC_DENY }],
    });
  });
});
