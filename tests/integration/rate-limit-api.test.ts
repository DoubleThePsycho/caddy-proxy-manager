/**
 * Rate limiting over the REST API: the rate-limit settings group
 * (GET/PUT /api/v1/settings/rate-limit) and the rateLimit field of proxy
 * hosts, with a real database. Covers strict validation (400, nothing
 * stored), the permission each route names, the audit event, the rollback
 * when Caddy refuses the configuration, and that the documented camelCase
 * fields round-trip.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb, permissions: new Set<string>() }));

vi.mock('../../src/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db');
  ctx.db = createTestDb();
  return (await import('../helpers/db-module')).mockDbModule(() => ctx.db);
});

vi.mock('../../src/lib/caddy', () => ({
  applyCaddyConfig: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

vi.mock('../../src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-auth')>();
  const { builtInAccess } = await import('../../src/lib/permissions');
  return {
    ...actual,
    // The caller holds exactly ctx.permissions (as an administrator for the scope checks).
    requireApiPermission: vi.fn(async (_request: unknown, permission: string) => {
      if (!ctx.permissions.has(permission)) throw new actual.ApiAuthError('Forbidden', 403);
      return { userId: 1, role: 'admin', authMethod: 'bearer', access: builtInAccess(1, 'admin') };
    }),
  };
});

import { GET as getSettings, PUT as putSettings } from '../../app/api/v1/settings/[group]/route';
import { POST as createHost } from '../../app/api/v1/proxy-hosts/route';
import { GET as getHost, PUT as updateHost } from '../../app/api/v1/proxy-hosts/[id]/route';
import { GET as getOpenApi } from '../../app/api/v1/openapi.json/route';
import * as schema from '../../src/lib/db/schema';
import { getSetting } from '../../src/lib/settings';
import { applyCaddyConfig } from '../../src/lib/caddy';
import { CaddyApplyError } from '../../src/lib/caddy-apply-error';
import { logAuditEvent } from '../../src/lib/audit';

function request(body?: unknown): any {
  return {
    headers: { get: () => null },
    method: body === undefined ? 'GET' : 'PUT',
    nextUrl: { pathname: '/api/v1/test', searchParams: new URLSearchParams() },
    json: async () => body,
  };
}

const group = (name: string) => ({ params: Promise.resolve({ group: name }) });
const hostId = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

const validSettings = {
  enabled: true,
  rules: [
    { path: '/login', methods: ['post'], events: 5, window: '1m' },
    { key: 'header', header: 'X-Api-Key', events: 100, window: '1m' },
  ],
  allowlist: ['192.0.2.10', '198.51.100.0/24'],
  ipv6Prefix: 56,
};

beforeEach(async () => {
  ctx.permissions = new Set(['settings:read', 'settings:write', 'proxy_hosts:read', 'proxy_hosts:write']);
  vi.mocked(applyCaddyConfig).mockReset().mockResolvedValue({ ok: true } as never);
  vi.mocked(logAuditEvent).mockClear();
  for (const table of [schema.proxyHosts, schema.settings, schema.users]) {
    await ctx.db.delete(table).catch(() => {});
  }
  await ctx.db.insert(schema.users).values({
    id: 1, email: 'admin@example.com', name: 'Admin', role: 'admin', provider: 'credentials', subject: 'admin',
    status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
});

describe('/api/v1/settings/rate-limit', () => {
  it('answers the defaults when nothing is stored', async () => {
    const response = await getSettings(request(), group('rate-limit'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false, rules: [], allowlist: [] });
  });

  it('stores the normalized settings, applies Caddy, audits, and reads them back', async () => {
    const response = await putSettings(request(validSettings), group('rate-limit'));
    expect(response.status).toBe(200);
    const expected = {
      enabled: true,
      rules: [
        { path: '/login', methods: ['POST'], key: 'client_ip', events: 5, window: '1m' },
        { path: '*', methods: [], key: 'header', header: 'X-Api-Key', events: 100, window: '1m' },
      ],
      allowlist: ['192.0.2.10', '198.51.100.0/24'],
      ipv6Prefix: 56,
    };
    expect(await getSetting('rate_limit')).toEqual(expected);
    expect(applyCaddyConfig).toHaveBeenCalledTimes(1);
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 1, action: 'update', entityType: 'setting', summary: 'Updated rate limiting defaults',
    }));

    const read = await getSettings(request(), group('rate-limit'));
    expect(await read.json()).toEqual(expected);
  });

  it.each([
    ['an unknown field', { ...validSettings, burst: 10 }, /unknown field: burst/],
    ['a window over an hour', { ...validSettings, rules: [{ events: 5, window: '2h' }] }, /rules\[0\]\.window/],
    ['a placeholder in a path', { ...validSettings, rules: [{ path: '/{http.request.uri}', events: 5, window: '1m' }] }, /rules\[0\]\.path/],
    ['an invalid header name', { ...validSettings, rules: [{ key: 'header', header: 'X Api', events: 5, window: '1m' }] }, /rules\[0\]\.header/],
    ['too many events', { ...validSettings, rules: [{ events: 1_000_000, window: '1m' }] }, /events/],
    ['a host name in the allowlist', { ...validSettings, allowlist: ['monitor.example.com'] }, /allowlist\[0\]/],
    ['a missing enabled flag', { rules: [] }, /enabled/],
  ])('refuses %s with 400 and stores nothing', async (_label, body, message) => {
    const response = await putSettings(request(body), group('rate-limit'));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(message);
    expect(await getSetting('rate_limit')).toBeNull();
    expect(applyCaddyConfig).not.toHaveBeenCalled();
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it('needs settings:write to change and settings:read to read', async () => {
    ctx.permissions = new Set(['proxy_hosts:read', 'proxy_hosts:write']);
    expect((await putSettings(request(validSettings), group('rate-limit'))).status).toBe(403);
    expect((await getSettings(request(), group('rate-limit'))).status).toBe(403);
    expect(await getSetting('rate_limit')).toBeNull();
  });

  it('rolls the settings back when Caddy refuses the configuration', async () => {
    await putSettings(request({ enabled: false }), group('rate-limit'));
    vi.mocked(applyCaddyConfig).mockRejectedValueOnce(new CaddyApplyError('Caddy rejected configuration', 'CADDY_REJECTED'));
    const response = await putSettings(request(validSettings), group('rate-limit'));
    expect(response.status).toBe(502);
    expect(await getSetting('rate_limit')).toEqual({ enabled: false, rules: [], allowlist: [] });
  });
});

describe('proxy host rateLimit over the API', () => {
  const base = { name: 'App', domains: ['app.example.com'], upstreams: ['10.0.0.1:8080'] };

  it('creates, reads, keeps and removes per-host rate limiting', async () => {
    const created = await createHost(request({
      ...base,
      rateLimit: { mode: 'override', rules: [{ path: '/api/*', methods: ['get', 'POST'], key: 'forward_auth_user', events: 60, window: '1m' }] },
    }));
    expect(created.status).toBe(201);
    const host = await created.json();
    const stored = {
      enabled: true,
      mode: 'override',
      rules: [{ path: '/api/*', methods: ['GET', 'POST'], key: 'forward_auth_user', events: 60, window: '1m' }],
    };
    expect(host.rateLimit).toEqual(stored);
    expect((await (await getHost(request(), hostId(host.id))).json()).rateLimit).toEqual(stored);

    // Leaving rateLimit out keeps it.
    const renamed = await updateHost(request({ name: 'Renamed' }), hostId(host.id));
    expect((await renamed.json()).rateLimit).toEqual(stored);

    // null removes it: the host inherits the global defaults again.
    const removed = await updateHost(request({ rateLimit: null }), hostId(host.id));
    expect((await removed.json()).rateLimit).toBeNull();
  });

  it.each([
    ['an unknown field', { rules: [], allowlist: [] }, /unknown field: allowlist/],
    ['a bad mode', { mode: 'replace', rules: [] }, /rateLimit\.mode/],
    ['a header on a client-IP rule', { rules: [{ header: 'X-Api-Key', events: 5, window: '1m' }] }, /only allowed when key is "header"/],
    ['an identity header key', { rules: [{ key: 'header', header: 'X-Ingressi-User', events: 5, window: '1m' }] }, /forward_auth_user/],
    ['too many rules', { rules: Array.from({ length: 21 }, (_, i) => ({ events: i + 1, window: '1m' })) }, /at most 20/],
  ])('refuses %s with 400', async (_label, rateLimit, message) => {
    const response = await createHost(request({ ...base, rateLimit }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(message);
    expect(await ctx.db.select().from(schema.proxyHosts)).toHaveLength(0);
  });

  it('needs proxy_hosts:write', async () => {
    ctx.permissions = new Set(['proxy_hosts:read', 'settings:write']);
    const response = await createHost(request({ ...base, rateLimit: { rules: [{ events: 5, window: '1m' }] } }));
    expect(response.status).toBe(403);
  });
});

describe('OpenAPI', () => {
  it('documents the settings group and the proxy host field', async () => {
    ctx.permissions.add('api_docs:read');
    const spec = await (await getOpenApi(request())).json() as any;
    const groups = spec.paths['/api/v1/settings/{group}'].put.parameters[0].schema.enum;
    expect(groups).toContain('rate-limit');
    expect(spec.components.schemas.ProxyHost.properties.rateLimit).toBeDefined();
    expect(spec.components.schemas.ProxyHostInput.properties.rateLimit).toBeDefined();
    expect(Object.keys(spec.components.schemas.RateLimitRule.properties).sort()).toEqual(['events', 'header', 'key', 'methods', 'path', 'window']);
    expect(Object.keys(spec.components.schemas.RateLimitSettings.properties).sort()).toEqual(['allowlist', 'enabled', 'ipv6Prefix', 'rules']);
  });
});
