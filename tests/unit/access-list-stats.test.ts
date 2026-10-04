/**
 * What access lists stopped (src/lib/access-list-stats.ts): bound
 * parameters only, the outcome column when present and is_blocked
 * otherwise, attribution of events to hosts (exact domains before
 * wildcards), failed sign-ins only for basic-auth lists, Blocked sources
 * matched by address range and country, and graceful degradation. Also the
 * access log marker that makes a list's own denials count as blocked.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  buildHostResolver,
  hostCondition,
  queryAccessListStats,
  resetAccessListStatsCache,
  sourceCondition,
  toIpv6Cidr,
  type StatsDependencies,
} from '@/src/lib/access-list-stats';
import { isAccessListDenial, parseLine } from '@/src/lib/log-parser';
import { ACCESS_LIST_LOG_FIELD } from '@/src/lib/access-list-rules';

type Call = { query: string; params: Record<string, unknown> };

function fakeDeps(options: { outcome?: boolean; rows?: (query: string) => unknown[]; fail?: boolean } = {}) {
  const calls: Call[] = [];
  const deps: StatsDependencies = {
    enabled: () => true,
    query: async <T,>(query: string, params: Record<string, unknown>) => {
      calls.push({ query, params });
      if (options.fail) throw new Error('connect ECONNREFUSED');
      if (query.includes('system.columns')) return [{ present: options.outcome ? 1 : 0 }] as T[];
      return (options.rows?.(query) ?? []) as T[];
    },
  };
  return { deps, calls };
}

const lists = [
  { id: 1, basicAuth: true, hosts: [{ id: 10, domains: ['app.example.com', '*.example.org'] }] },
  { id: 2, basicAuth: false, hosts: [{ id: 11, domains: ['api.example.org'] }] },
];

beforeEach(() => resetAccessListStatsCache());

describe('queryAccessListStats', () => {
  it('reports nothing and stays unavailable without analytics', async () => {
    const stats = await queryAccessListStats({ lists, blockedSources: null, includeRequests: true }, { enabled: () => false, query: async () => { throw new Error('not called'); } });
    expect(stats).toMatchObject({ available: false, stopped: 0, requests: null, lists: { 1: { stopped: 0, hosts: { 10: { stopped: 0 } } } } });
  });

  it('degrades to unavailable when ClickHouse fails', async () => {
    const { deps } = fakeDeps({ fail: true });
    const stats = await queryAccessListStats({ lists, blockedSources: null, includeRequests: true }, deps);
    expect(stats.available).toBe(false);
    expect(stats.stopped).toBe(0);
  });

  it('counts is_blocked without the outcome column, and the outcome split with it', async () => {
    const plain = fakeDeps();
    await queryAccessListStats({ lists, blockedSources: null, includeRequests: false }, plain.deps);
    const summary = plain.calls.find((call) => call.query.includes('AS stopped'))!;
    expect(summary.query).toContain('is_blocked');
    expect(summary.query).not.toContain('outcome');

    resetAccessListStatsCache();
    const withOutcome = fakeDeps({
      outcome: true,
      rows: (query) => (query.includes('AS stopped') && query.includes('AS geo') ? [{ requests: 0, stopped: 9, previous: 4, failed_sign_ins: 1, blocked_sources: 0, geo: 6, access: 3 }] : []),
    });
    const stats = await queryAccessListStats({ lists, blockedSources: null, includeRequests: false }, withOutcome.deps);
    expect(withOutcome.calls.find((call) => call.query.includes('AS stopped'))!.query).toContain("outcome IN ('geo', 'access')");
    expect(stats).toMatchObject({ available: true, stopped: 9, previous: 4, failedSignIns: 1, byOutcome: { geo: 6, access: 3 }, requests: null });
  });

  it('binds every domain, address and country as a parameter', async () => {
    const { deps, calls } = fakeDeps();
    await queryAccessListStats(
      {
        lists: [{ id: 1, basicAuth: false, hosts: [{ id: 10, domains: ["evil'.example.com) OR 1=1 --"] }] }],
        blockedSources: { addresses: ['198.51.100.19'], countries: ['KP', "X'); DROP"] },
        includeRequests: true,
      },
      deps
    );
    for (const call of calls) {
      expect(call.query).not.toContain('evil');
      expect(call.query).not.toContain('198.51.100.19');
      expect(call.query).not.toContain('DROP');
    }
    const summary = calls.find((call) => call.query.includes('AS stopped'))!;
    expect(Object.values(summary.params)).toEqual(expect.arrayContaining(["evil'.example.com) or 1=1 --", '::ffff:198.51.100.19/128', 'KP']));
    // Not a country code: left out, not bound.
    expect(Object.values(summary.params)).not.toContain("X'); DROP");
  });

  it('attributes events to hosts and lists, exact domains before wildcards, sign-ins to basic-auth lists only', async () => {
    const { deps } = fakeDeps({
      rows: (query) =>
        query.includes('GROUP BY h')
          ? [
              { h: 'app.example.com', stopped: 3, unauthorized: 2 },
              { h: 'www.example.org', stopped: 4, unauthorized: 1 },
              { h: 'api.example.org', stopped: 5, unauthorized: 7 },
              { h: 'other.example.net', stopped: 9, unauthorized: 9 },
            ]
          : [],
    });
    const stats = await queryAccessListStats({ lists, blockedSources: null, includeRequests: false }, deps);
    expect(stats.lists[1]).toEqual({ stopped: 7, failedSignIns: 3, hosts: { 10: { stopped: 7, failedSignIns: 3 } } });
    expect(stats.lists[2]).toEqual({ stopped: 5, failedSignIns: 0, hosts: { 11: { stopped: 5, failedSignIns: 0 } } });
  });

  it('asks for the request total and Blocked sources only when allowed to', async () => {
    const { deps, calls } = fakeDeps();
    const stats = await queryAccessListStats({ lists, blockedSources: null, includeRequests: false }, deps);
    expect(calls.find((call) => call.query.includes('AS requests'))!.query).toMatch(/0 AS requests/);
    expect(stats.requests).toBeNull();
    expect(stats.blockedSources).toBeNull();
  });
});

describe('query helpers', () => {
  it('matches exact domains and wildcards case-insensitively', () => {
    const condition = hostCondition(['App.Example.com', '*.example.org', ''])!;
    expect(condition.sql).toContain('IN ({de0:String})');
    expect(condition.sql).toContain('endsWith(');
    expect(condition.params).toEqual({ de0: 'app.example.com', dw1: '.example.org' });
    expect(hostCondition([])).toBeNull();
  });

  it('resolves host names to the most specific owner', () => {
    const resolve = buildHostResolver([
      { id: 1, basicAuth: false, hosts: [{ id: 10, domains: ['*.example.org'] }] },
      { id: 2, basicAuth: false, hosts: [{ id: 11, domains: ['*.api.example.org', 'exact.example.org'] }] },
    ]);
    expect(resolve('www.example.org')).toEqual({ hostId: 10, listId: 1 });
    expect(resolve('v1.api.example.org')).toEqual({ hostId: 11, listId: 2 });
    expect(resolve('exact.example.org')).toEqual({ hostId: 11, listId: 2 });
    expect(resolve('example.org')).toBeNull();
  });

  it('turns addresses and ranges into IPv6 CIDRs', () => {
    expect(toIpv6Cidr('198.51.100.19')).toBe('::ffff:198.51.100.19/128');
    expect(toIpv6Cidr('198.51.100.0/24')).toBe('::ffff:198.51.100.0/120');
    expect(toIpv6Cidr('2001:db8::1')).toBe('2001:db8::1/128');
    expect(toIpv6Cidr('2001:db8::/32')).toBe('2001:db8::/32');
    expect(toIpv6Cidr('nope')).toBeNull();
    const condition = sourceCondition({ addresses: ['private_ranges'], countries: [] })!;
    expect(Object.values(condition.params)).toContain('::ffff:10.0.0.0/104');
    expect(sourceCondition({ addresses: [], countries: [] })).toBeNull();
  });
});

describe('the access log marker', () => {
  const line = (extra: Record<string, unknown>) =>
    JSON.stringify({
      ts: 1_790_000_000,
      msg: 'handled request',
      status: 403,
      request: { client_ip: '198.51.100.19', host: 'app.example.com', method: 'GET', uri: '/', proto: 'HTTP/2.0', headers: {} },
      ...extra,
    });

  it('counts a denial an access list answered itself as blocked', () => {
    expect(ACCESS_LIST_LOG_FIELD).toBe('access_list');
    expect(parseLine(line({ access_list: '7' }), new Map())!.is_blocked).toBe(true);
    expect(parseLine(line({ access_list: 'blocked_sources' }), new Map())!.is_blocked).toBe(true);
    expect(parseLine(line({}), new Map())!.is_blocked).toBe(false);
    expect(isAccessListDenial({ access_list: '' })).toBe(false);
    expect(isAccessListDenial({ access_list: 7 })).toBe(false);
  });
});
