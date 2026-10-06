/**
 * The traffic and sign-in sources of the overview's "Needs attention"
 * (src/lib/attention/traffic-provider.ts and identity-provider.ts): what
 * each signal becomes, the links each reader gets, the permissions each
 * source answers for, and the signal cache.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import type { TrafficSignals } from '../../src/lib/analytics/signals';
import type { IdentityHealth } from '../../src/lib/identity-health';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  signals: null as unknown as TrafficSignals,
  identity: { directories: [], issues: [] } as IdentityHealth,
}));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('../../src/lib/analytics/signals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/analytics/signals')>()),
  getTrafficSignals: vi.fn(async () => ctx.signals),
}));
vi.mock('../../src/lib/identity-health', () => ({
  getIdentityHealth: vi.fn(() => ctx.identity),
}));

import { builtInAccess, type Access, type Permission } from '../../src/lib/permissions';
import { collectAttention } from '../../src/lib/attention';
import type { AttentionItem } from '../../src/lib/attention/types';
import { getTrafficSignals } from '../../src/lib/analytics/signals';
import { cachedTrafficSignals, clearTrafficSignalsCache, countryName, utcClock } from '../../src/lib/attention/traffic-provider';
import { analyticsHref, securityHref } from '../../src/lib/analytics/links';
import { first } from '@/src/lib/db/ops';

/** The filters of a link, decoded. */
function linkFilters(route: string): unknown {
  return JSON.parse(new URL(route, 'http://localhost').searchParams.get('filters') ?? 'null');
}

const NOW = Math.floor(Date.parse('2026-10-03T11:36:00.000Z') / 1000);
const stamp = () => new Date().toISOString();
let adminId: number;
let memberId: number;
let mailHostId: number;

async function user(email: string, role: string): Promise<number> {
  return (await first(ctx.db.insert(schema.users).values({ email, name: email.split('@')[0], role, status: 'active', createdAt: stamp(), updatedAt: stamp() }).returning()))!.id;
}

function custom(permissions: Permission[], scopeTags: string[] = []): Access {
  return { ...builtInAccess(memberId, 'viewer'), customRole: { id: 1, name: 'Custom' }, permissions: new Set(permissions), scopeTags };
}

function signals(overrides: Partial<TrafficSignals> = {}): TrafficSignals {
  return {
    status: 'ok',
    generatedAt: NOW,
    errorBursts: [
      { host: 'mail.example.com', proxyHostId: mailHostId, count: 143, requests: 1200, start: NOW - 9000, end: NOW - 8926, ongoing: false, status: 501, method: 'POST', path: '/Microsoft-Server-ActiveSync' },
      { host: 'api.example.com', proxyHostId: null, count: 40, requests: 100, start: NOW - 240, end: NOW - 30, ongoing: true, status: 502, method: 'GET', path: '/' },
    ],
    mitigationSpikes: [
      { host: 'mail.example.com', proxyHostId: mailHostId, count: 600, baseline: 20, factor: 30, topOutcome: 'waf' },
      { host: 'shop.example.com', proxyHostId: null, count: 120, baseline: 0, factor: null, topOutcome: 'geo' },
    ],
    blockedConcentrations: [
      {
        host: 'example.com', proxyHostId: null, path: '/portal', outcome: 'geo', count: 826, shareOfHost: 0.9,
        countries: [{ country: 'HK', count: 300 }, { country: 'IN', count: 200 }, { country: 'AU', count: 100 }, { country: 'KR', count: 100 }, { country: 'XX', count: 6 }],
        wafRuleId: null,
      },
      { host: 'example.com', proxyHostId: null, path: '/api', outcome: 'waf', count: 100, shareOfHost: 0.1, countries: [{ country: 'LAN', count: 100 }], wafRuleId: 920450 },
    ],
    ...overrides,
  };
}

async function items(access: Access, source: string): Promise<AttentionItem[]> {
  const view = await collectAttention(access, { now: new Date(NOW * 1000) });
  return view.items.filter((item) => item.source === source);
}

const byId = (list: AttentionItem[], prefix: string) => list.filter((item) => item.id.startsWith(prefix));

beforeEach(async () => {
  ctx.db = createTestDb();
  vi.clearAllMocks();
  clearTrafficSignalsCache();
  adminId = await user('admin@example.com', 'admin');
  memberId = await user('member@example.com', 'viewer');
  mailHostId = (await first(ctx.db
    .insert(schema.proxyHosts)
    .values({ name: 'Mail', domains: '["mail.example.com"]', upstreams: '[]', tags: '[]', createdAt: stamp(), updatedAt: stamp() })
    .returning()))!.id;
  ctx.signals = signals();
  ctx.identity = { directories: [], issues: [] };
});

describe('traffic signals', () => {
  it('turns 5xx bursts into items: critical while going on, a warning once over', async () => {
    const list = await items(builtInAccess(adminId, 'admin'), 'traffic');
    const [ongoing, over] = [byId(list, 'burst:api.example.com')[0], byId(list, 'burst:mail.example.com')[0]];
    expect(ongoing).toMatchObject({
      severity: 'critical',
      title: `api.example.com is answering with server errors: 40 since ${utcClock(NOW - 240, NOW)}`,
      actions: [{ label: 'Show requests', route: analyticsHref([{ dim: 'host', value: 'api.example.com' }, { dim: 'status', value: '5xx' }]) }],
    });
    expect(ongoing.detail).toContain('Mostly 502 to GET /, 40% of its requests since then.');
    expect(over).toMatchObject({
      severity: 'warning',
      title: 'mail.example.com answered 143 requests with server errors at 09:06 UTC',
      at: new Date((NOW - 9000) * 1000).toISOString(),
      actions: [
        { label: 'Open host', route: `/proxy-hosts/${mailHostId}` },
        { label: 'Show requests', route: analyticsHref([{ dim: 'host', value: 'mail.example.com' }, { dim: 'status', value: '5xx' }]) },
      ],
    });
    expect(over.detail).toBe('Mostly 501 to POST /Microsoft-Server-ActiveSync, until 09:07 UTC (12% of its requests in those minutes); normal again since.');
  });

  it('turns mitigation spikes into items, a warning at ten times the usual', async () => {
    const list = await items(builtInAccess(adminId, 'admin'), 'traffic');
    expect(byId(list, 'spike:mail.example.com')[0]).toMatchObject({
      severity: 'warning',
      title: '600 mitigated requests to mail.example.com, 30 times its daily average',
      detail: 'Mostly WAF blocks in the last 24 hours, against a daily average of 20 over the 7 days before.',
      actions: [
        { label: 'Open host', route: `/proxy-hosts/${mailHostId}` },
        { label: 'Security events', route: securityHref({ kind: 'waf', filters: [{ dim: 'host', value: 'mail.example.com' }] }) },
      ],
    });
    expect(byId(list, 'spike:shop.example.com')[0]).toMatchObject({
      severity: 'info',
      title: '120 mitigated requests to shop.example.com, none in the week before',
      actions: [
        { label: 'Show requests', route: analyticsHref([{ dim: 'host', value: 'shop.example.com' }, { dim: 'outcome', op: 'is_not', value: 'served' }]) },
        { label: 'Security events', route: securityHref({ kind: 'geo', filters: [{ dim: 'host', value: 'shop.example.com' }] }) },
      ],
    });
    ctx.signals = signals({ mitigationSpikes: [{ host: 'shop.example.com', proxyHostId: null, count: 500, baseline: 0, factor: null, topOutcome: 'geo' }] });
    clearTrafficSignalsCache();
    expect(byId(await items(builtInAccess(adminId, 'admin'), 'traffic'), 'spike:')[0].severity).toBe('warning');
  });

  it('turns blocked-traffic concentrations into items with their countries and rule', async () => {
    const list = await items(builtInAccess(adminId, 'admin'), 'traffic');
    const geo = byId(list, 'blocked:example.com:geo')[0];
    expect(geo).toMatchObject({
      severity: 'info',
      title: 'Geo rules blocked 826 requests to example.com/portal',
      actions: [
        { label: 'Show requests', route: analyticsHref([{ dim: 'host', value: 'example.com' }, { dim: 'path', value: '/portal' }, { dim: 'outcome', value: 'geo' }]) },
        { label: 'Security events', route: securityHref({ kind: 'geo', filters: [{ dim: 'host', value: 'example.com' }, { dim: 'path', value: '/portal' }] }) },
      ],
    });
    expect(geo.detail).toMatch(/^From .+India, Australia and .+, 90% of what was mitigated on this host in the last 24 hours\.$/);
    expect(linkFilters(geo.actions[0].route)).toEqual([
      { dim: 'host', op: 'is', value: 'example.com' },
      { dim: 'path', op: 'is', value: '/portal' },
      { dim: 'outcome', op: 'is', value: 'geo' },
    ]);
    expect(geo.actions[1].route).toMatch(/^\/security\?range=24h&kind=geo&filters=.+#events$/);
    const waf = byId(list, 'blocked:example.com:waf')[0];
    expect(waf.title).toBe('The WAF blocked 100 requests to example.com/api');
    expect(waf.detail).toBe('From the local network, 10% of what was mitigated on this host in the last 24 hours. Mostly rule 920450.');
  });

  it('links to hosts and security events only for readers who may open them', async () => {
    const analyst = await items(custom(['analytics:read']), 'traffic');
    expect(analyst).toHaveLength(6);
    for (const item of analyst) {
      expect(item.actions.map((action) => action.route).every((route) => route.startsWith('/analytics?'))).toBe(true);
    }
    // A tag scope that leaves the host out: no link to it.
    const scoped = await items(custom(['analytics:read', 'proxy_hosts:read', 'waf:read'], ['team-a']), 'traffic');
    expect(scoped.flatMap((item) => item.actions).some((action) => action.route.startsWith('/proxy-hosts/'))).toBe(false);
    expect(scoped.flatMap((item) => item.actions).some((action) => action.route.startsWith('/security?'))).toBe(true);
  });

  it('answers only readers of the analytics, and nothing while analytics are off', async () => {
    expect((await collectAttention(builtInAccess(memberId, 'viewer'))).sources.map((source) => source.id)).not.toContain('traffic');
    expect((await collectAttention(custom(['analytics:read']))).sources.map((source) => source.id)).toContain('traffic');
    ctx.signals = signals({ status: 'disabled' });
    clearTrafficSignalsCache();
    expect(await items(builtInAccess(adminId, 'admin'), 'traffic')).toEqual([]);
  });

  it('reuses the signals for 30 seconds', async () => {
    await cachedTrafficSignals(1_000_000);
    await cachedTrafficSignals(1_010_000);
    expect(getTrafficSignals).toHaveBeenCalledTimes(1);
    await cachedTrafficSignals(1_031_000);
    expect(getTrafficSignals).toHaveBeenCalledTimes(2);
  });

  it('names countries, the local network and unknown ones', () => {
    expect(countryName('DE')).toBe('Germany');
    expect(countryName('LAN')).toBe('the local network');
    expect(countryName('XX')).toBeNull();
    expect(utcClock(NOW - 86_400, NOW)).toBe('2 Oct 11:36 UTC');
  });
});

describe('sign-in health', () => {
  beforeEach(() => {
    ctx.identity = {
      directories: [],
      issues: [
        {
          kind: 'directory_failing', severity: 'critical', directoryId: 4, name: 'Corp LDAP', failingSince: '2026-10-03T09:00:00.000Z',
          consecutiveFailures: 3, lastError: 'Service account bind: invalid credentials (LDAP result 49)', message: 'm',
        },
        { kind: 'mfa_overdue', severity: 'warning', accounts: 2, message: 'm' },
      ],
    };
  });

  it('reports failing directories and accounts locked out by the MFA policy', async () => {
    const list = await items(builtInAccess(adminId, 'admin'), 'identity');
    expect(list).toEqual([
      expect.objectContaining({
        id: 'directory:4',
        severity: 'critical',
        title: 'People cannot sign in through the directory "Corp LDAP"',
        detail:
          'Service account bind: invalid credentials (LDAP result 49) (the last 3 checks in a row, failing since 2026-10-03 09:00 UTC). Accounts from other sign-in methods are not affected.',
        actions: [{ label: 'Open directories', route: '/ldap' }],
      }),
      expect.objectContaining({
        id: 'mfa_overdue',
        severity: 'warning',
        title: '2 accounts are locked out until they set up multi-factor authentication',
        actions: [{ label: 'Review accounts', route: '/users' }],
      }),
    ]);
  });

  it('shows each issue only to readers of what it is about', async () => {
    expect((await items(custom(['users:read']), 'identity')).map((item) => item.id)).toEqual(['mfa_overdue']);
    expect((await items(custom(['ldap:read']), 'identity')).map((item) => item.id)).toEqual(['directory:4']);
    expect((await collectAttention(builtInAccess(memberId, 'viewer'))).sources.map((source) => source.id)).not.toContain('identity');
  });
});
