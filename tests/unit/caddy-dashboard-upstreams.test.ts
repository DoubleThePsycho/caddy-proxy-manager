/**
 * Where the generated Caddy configuration sends what it asks the dashboard
 * (src/lib/dashboard-upstreams.ts): the forward-auth verify subrequest, the
 * sign-in callback of protected hosts and the API monetization gate.
 *
 * - Without DASHBOARD_UPSTREAMS, or with one address, every such handler is
 *   exactly as before: one upstream, no health checks, no retries.
 * - With several replicas, each handler lists them all, with active health
 *   checks on /api/health, passive health checks and retries; the gate is
 *   never retried once a replica may have charged.
 * - Entries that are not addresses are refused at start-up in production.
 * Same approach as caddy-forward-auth-header-strip.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db');
  ctx.db = createTestDb();
  return (await import('../helpers/db-module')).mockDbModule(() => ctx.db);
});

vi.mock('../../src/lib/caddy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/caddy')>();
  return { ...actual, applyCaddyConfig: vi.fn().mockResolvedValue({ ok: true }) };
});

vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

// Models before src/lib/caddy (see the caddy test mock import order note).
import { createProxyHost } from '../../src/lib/models/proxy-hosts';
import { buildCaddyDocument } from '../../src/lib/caddy';
import * as schema from '../../src/lib/db/schema';
import { insertMonetizedHost } from '../helpers/monetization';
import { resetMonetizationEngineForTests } from '../../ee/monetization/engine';
import {
  assertValidDashboardUpstreams,
  DashboardUpstreamsError,
  dashboardProxyFields,
  parseDashboardUpstreams,
} from '../../src/lib/dashboard-upstreams';

const UPSTREAM = '10.0.0.5:8080';

type Handler = Record<string, any>;

function collectHandlers(node: unknown, out: Handler[] = []): Handler[] {
  if (Array.isArray(node)) {
    for (const item of node) collectHandlers(item, out);
  } else if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.handle)) out.push(...(obj.handle as Handler[]));
    for (const v of Object.values(obj)) collectHandlers(v, out);
  }
  return out;
}

const rewriteUri = (h: Handler): string => (h?.handler === 'reverse_proxy' ? String(h.rewrite?.uri ?? '') : '');
const isVerify = (h: Handler) => rewriteUri(h) === '/api/forward-auth/verify';
const isCallback = (h: Handler) => rewriteUri(h).startsWith('/api/forward-auth/callback');
const isGate = (h: Handler) => rewriteUri(h) === '/api/monetization/gate';
const isUserUpstream = (h: Handler) =>
  h?.handler === 'reverse_proxy' && ((h.upstreams as Array<{ dial?: string }>) ?? []).some((u) => u.dial === UPSTREAM);

/** One host behind Ingressi forward auth and one monetized host: every handler that calls the dashboard. */
async function dashboardHandlers() {
  await createProxyHost(
    {
      name: 'protected',
      domains: ['app.example.com'],
      upstreams: [UPSTREAM],
      ingressiForwardAuth: { enabled: true },
      locationRules: [{ path: '/v2/*', upstreams: [UPSTREAM] }],
    },
    1
  );
  const api = await createProxyHost({ name: 'api', domains: ['api.example.com'], upstreams: [UPSTREAM] }, 1);
  await insertMonetizedHost(ctx.db, api.id);
  const handlers = collectHandlers(await buildCaddyDocument());
  const verify = handlers.filter(isVerify);
  const callback = handlers.filter(isCallback);
  const gate = handlers.filter(isGate);
  expect(verify.length).toBeGreaterThan(0);
  expect(callback.length).toBeGreaterThan(0);
  expect(gate.length).toBeGreaterThan(0);
  return { handlers, verify, callback, gate };
}

const EXPECTED_HEALTH_CHECKS = {
  active: { uri: '/api/health', interval: '10s', timeout: '5s', expect_status: 200 },
  passive: { fail_duration: '10s', max_fails: 3 },
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  resetMonetizationEngineForTests();
  await ctx.db.delete(schema.monetizationHosts);
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.settings);
  await ctx.db.delete(schema.users).catch(() => {});
  await ctx.db.insert(schema.users).values({
    id: 1, email: 'admin@example.com', name: 'Admin', role: 'admin', provider: 'credentials', subject: 'admin',
    status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('DASHBOARD_UPSTREAMS', () => {
  it('reads host:port entries, IPv6 in brackets and an http:// prefix, in order and without duplicates', () => {
    expect(parseDashboardUpstreams(' web-1:3000, http://web-2:3000/ ,[2001:db8::10]:3000,web-1:3000,,10.0.0.7:03000 ')).toEqual({
      upstreams: ['web-1:3000', 'web-2:3000', '[2001:db8::10]:3000', '10.0.0.7:3000'],
      invalidPositions: [],
    });
    expect(parseDashboardUpstreams(undefined)).toEqual({ upstreams: [], invalidPositions: [] });
    expect(parseDashboardUpstreams('  ')).toEqual({ upstreams: [], invalidPositions: [] });
  });

  it.each([
    ['web', 'no port'],
    ['web:0', 'port 0'],
    ['web:65536', 'port out of range'],
    ['web:http', 'port not a number'],
    ['https://web:3000', 'TLS is not used for the dashboard'],
    ['web:3000/api', 'a path'],
    ['user:secret@web:3000', 'credentials'],
    ['{env.HOST}:3000', 'a Caddy placeholder'],
    ['2001:db8::10:3000', 'IPv6 without brackets'],
    ['[web]:3000', 'a name in brackets'],
    ['we b:3000', 'a space'],
    ['-web:3000', 'a leading hyphen'],
  ])('refuses %s (%s)', (entry) => {
    expect(parseDashboardUpstreams(`web-1:3000,${entry}`)).toEqual({ upstreams: ['web-1:3000'], invalidPositions: [2] });
  });

  it('refuses invalid entries at start-up, naming their positions but never their text', () => {
    expect(() => assertValidDashboardUpstreams({ DASHBOARD_UPSTREAMS: 'web-1:3000,web-2:3000' })).not.toThrow();
    expect(() => assertValidDashboardUpstreams({})).not.toThrow();
    let error: unknown;
    try {
      assertValidDashboardUpstreams({ DASHBOARD_UPSTREAMS: 'web-1:3000,user:secret@web-2:3000,web-3' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DashboardUpstreamsError);
    expect((error as Error).message).toMatch(/^DASHBOARD_UPSTREAMS: entries 2, 3 are not an address/);
    expect((error as Error).message).not.toContain('secret');
  });

  it('adds health checks and retries only with several upstreams, and no retries after sending when asked', () => {
    expect(dashboardProxyFields(['web:3000'], { retryAfterSend: false })).toEqual({ upstreams: [{ dial: 'web:3000' }] });
    expect(dashboardProxyFields(['web-1:3000', 'web-2:3000'], { retryAfterSend: true })).toEqual({
      upstreams: [{ dial: 'web-1:3000' }, { dial: 'web-2:3000' }],
      health_checks: EXPECTED_HEALTH_CHECKS,
      load_balancing: { try_duration: '5s', try_interval: '250ms' },
    });
    expect(dashboardProxyFields(['web-1:3000', 'web-2:3000'], { retryAfterSend: false }).load_balancing).toEqual({
      try_duration: '5s',
      try_interval: '250ms',
      retry_match: [{ expression: 'false' }],
    });
  });
});

describe('Caddy configuration of the routes that call the dashboard', () => {
  it('keeps one upstream without health checks or retries when DASHBOARD_UPSTREAMS is unset', async () => {
    vi.stubEnv('DASHBOARD_UPSTREAMS', '');
    const { verify, callback, gate } = await dashboardHandlers();
    for (const handler of [...verify, ...callback, ...gate]) {
      // CADDY_API_URL names the caddy service: the dashboard is the web service.
      expect(handler.upstreams).toEqual([{ dial: 'web:3000' }]);
      expect(handler).not.toHaveProperty('health_checks');
      expect(handler).not.toHaveProperty('load_balancing');
    }
  });

  it('uses a single configured address as the one upstream, as before', async () => {
    vi.stubEnv('DASHBOARD_UPSTREAMS', 'http://dashboard.example.test:3000');
    const { verify, callback, gate } = await dashboardHandlers();
    for (const handler of [...verify, ...callback, ...gate]) {
      expect(handler.upstreams).toEqual([{ dial: 'dashboard.example.test:3000' }]);
      expect(handler).not.toHaveProperty('health_checks');
      expect(handler).not.toHaveProperty('load_balancing');
    }
  });

  it('sends verify, callback and gate to every replica, with health checks and retries', async () => {
    vi.stubEnv('DASHBOARD_UPSTREAMS', 'web:3000,web-2:3000,[2001:db8::12]:3000');
    const { handlers, verify, callback, gate } = await dashboardHandlers();
    const replicas = [{ dial: 'web:3000' }, { dial: 'web-2:3000' }, { dial: '[2001:db8::12]:3000' }];
    for (const handler of [...verify, ...callback, ...gate]) {
      expect(handler.upstreams).toEqual(replicas);
      expect(handler.health_checks).toEqual(EXPECTED_HEALTH_CHECKS);
      expect(handler.load_balancing.try_duration).toBe('5s');
      expect(handler.load_balancing.try_interval).toBe('250ms');
    }
    // Verify only reads, and a sign-in code is redeemed at most once: Caddy's
    // default (GET requests are retried) stands.
    for (const handler of [...verify, ...callback]) expect(handler.load_balancing).not.toHaveProperty('retry_match');
    // The gate charges when it answers: retried only when it never reached a replica.
    for (const handler of gate) expect(handler.load_balancing.retry_match).toEqual([{ expression: 'false' }]);

    // What else the handlers do is unchanged.
    for (const handler of verify) {
      expect(handler.rewrite).toEqual({ method: 'GET', uri: '/api/forward-auth/verify' });
      expect(handler.headers.request.set['X-Forwarded-Host']).toEqual(['{http.request.hostport}']);
      expect(handler.handle_response.map((r: Handler) => r.match)).toEqual([{ status_code: [2] }, { status_code: [401, 403] }]);
    }
    expect(gate[0].rewrite).toEqual({ method: 'GET', uri: '/api/monetization/gate' });

    // The hosts' own upstreams are not touched.
    const userProxies = handlers.filter(isUserUpstream);
    expect(userProxies.length).toBeGreaterThan(0);
    for (const handler of userProxies) {
      expect(handler.upstreams).toEqual([{ dial: UPSTREAM }]);
      expect(handler).not.toHaveProperty('health_checks');
    }
  });

  it('leaves out entries that are not addresses (production refuses to start with them)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('DASHBOARD_UPSTREAMS', 'web:3000,web-2,web-3:3000');
    const { verify, gate } = await dashboardHandlers();
    for (const handler of [...verify, ...gate]) {
      expect(handler.upstreams).toEqual([{ dial: 'web:3000' }, { dial: 'web-3:3000' }]);
    }
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/DASHBOARD_UPSTREAMS: entry 2 is not an address/));
    warn.mockRestore();
  });
});
