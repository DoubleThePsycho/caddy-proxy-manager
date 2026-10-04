/**
 * The generated Caddy configuration of a proxy host with API monetization on
 * (ee/monetization): the forward_auth-style subrequest to the gate with the
 * per-install gate token and the host id, the copy of the gate's consumer
 * headers on 2xx, and the strip of client-supplied X-Ingressi-Consumer-* and
 * X-Ingressi-Plan copies on every route before the gate and the upstream.
 * Same approach as caddy-forward-auth-header-strip.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
import { readGateSecret } from '../../ee/monetization/settings';
import { decideGate, reloadMonetization, resetMonetizationEngineForTests } from '../../ee/monetization/engine';

const UPSTREAM = '10.0.0.5:8080';
const GATE_HEADERS = ['X-Ingressi-Consumer-Id', 'X-Ingressi-Plan'];

function collectHandleArrays(node: unknown, out: unknown[][] = []): unknown[][] {
  if (Array.isArray(node)) {
    for (const item of node) collectHandleArrays(item, out);
  } else if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.handle)) out.push(obj.handle as unknown[]);
    for (const v of Object.values(obj)) collectHandleArrays(v, out);
  }
  return out;
}

const isUpstreamProxy = (h: unknown) => {
  const handler = h as Record<string, unknown>;
  return handler?.handler === 'reverse_proxy' && ((handler.upstreams as Array<{ dial?: string }>) ?? []).some((u) => u.dial === UPSTREAM);
};
const isGate = (h: unknown) => {
  const handler = h as Record<string, unknown>;
  return handler?.handler === 'reverse_proxy' && (handler.rewrite as { uri?: string } | undefined)?.uri === '/api/monetization/gate';
};
const isStrip = (h: unknown) => {
  const handler = h as Record<string, unknown>;
  const del = (handler?.request as { delete?: string[] } | undefined)?.delete;
  return handler?.handler === 'headers' && Array.isArray(del) && GATE_HEADERS.every((name) => del.includes(name));
};

async function monetizedHost(name: string, domain: string, extra: Record<string, unknown> = {}) {
  const host = await createProxyHost({ name, domains: [domain], upstreams: [UPSTREAM], ...extra }, 1);
  await insertMonetizedHost(ctx.db, host.id);
  return host;
}

beforeEach(async () => {
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

describe('Caddy configuration of a monetized host', () => {
  it('sends every upstream route through the strip handler and then the gate', async () => {
    await monetizedHost('api', 'api.example.com', { locationRules: [{ path: '/v2/*', upstreams: [UPSTREAM] }] });
    const doc = await buildCaddyDocument();
    const upstreamRoutes = collectHandleArrays(doc).filter((arr) => arr.some(isUpstreamProxy));
    expect(upstreamRoutes.length).toBeGreaterThanOrEqual(2); // location rule + catch-all
    for (const arr of upstreamRoutes) {
      const strip = arr.findIndex(isStrip);
      const gate = arr.findIndex(isGate);
      const upstream = arr.findIndex(isUpstreamProxy);
      expect(strip).toBeGreaterThanOrEqual(0);
      expect(gate).toBeGreaterThan(strip);
      expect(upstream).toBeGreaterThan(gate);
    }
  });

  it('wires the gate subrequest like forward auth, with the gate token and the host id', async () => {
    const host = await monetizedHost('api', 'api.example.com');
    const doc = await buildCaddyDocument();
    const gate = collectHandleArrays(doc).flat().find(isGate) as Record<string, any>;
    const secret = await readGateSecret();
    expect(secret).not.toBeNull();

    expect(gate.rewrite).toEqual({ method: 'GET', uri: '/api/monetization/gate' });
    expect(gate.upstreams).toHaveLength(1);
    expect(gate.headers.request.set).toEqual({
      'X-Ingressi-Gate-Token': [secret!.token],
      'X-Ingressi-Host-Id': [String(host.id)],
      'X-Forwarded-Uri': ['{http.request.uri}'],
      // Caddy's own view of the client (the connection, or what trusted proxies report), replacing any client copy.
      'X-Ingressi-Client-Ip': ['{http.vars.client_ip}'],
    });
    expect(gate.handle_response).toHaveLength(1);
    expect(gate.handle_response[0].match).toEqual({ status_code: [2] });
    const copies = JSON.stringify(gate.handle_response[0].routes);
    for (const name of GATE_HEADERS) {
      expect(copies).toContain(`"set":{"${name}":["{http.reverse_proxy.header.${name}}"]}`);
    }
    // Non-2xx answers (401/402/403/429) are not handled: Caddy returns them to the client as the gate wrote them.

    // Failed-answer credits: the charge id goes into the access log, read before the upstream answers.
    const routes = gate.handle_response[0].routes as Array<Record<string, any>>;
    const chargeLog = routes.find((route) => route.handle?.[0]?.handler === 'log_append');
    expect(chargeLog).toEqual({
      handle: [{ handler: 'log_append', key: 'ingressi_charge', value: '{http.reverse_proxy.header.X-Ingressi-Charge}', early: true }],
      match: [{ not: [{ vars: { '{http.reverse_proxy.header.X-Ingressi-Charge}': [''] } }] }],
    });
    // x402: the settlement answer reaches the client; the payment payload never reaches the upstream.
    expect(routes).toContainEqual({
      handle: [{ handler: 'headers', response: { set: { 'Payment-Response': ['{http.reverse_proxy.header.Payment-Response}'] } } }],
      match: [{ not: [{ vars: { '{http.reverse_proxy.header.Payment-Response}': [''] } }] }],
    });
    expect(routes).toContainEqual({ handle: [{ handler: 'headers', request: { delete: ['Payment-Signature', 'X-Payment'] } }] });

    // The token in the configuration is the one the gate accepts.
    await reloadMonetization();
    expect(decideGate({ gateToken: secret!.token, hostId: String(host.id), header: () => null })).toMatchObject({ status: 401 });
  });

  it('sets the client address on the gate subrequest itself, so a client cannot choose it (x402 per-address limit)', async () => {
    await monetizedHost('api', 'api.example.com');
    const doc = await buildCaddyDocument();
    const gate = collectHandleArrays(doc).flat().find(isGate) as Record<string, any>;
    // "set" replaces whatever the client sent under that name; nothing else feeds it.
    expect(gate.headers.request.set['X-Ingressi-Client-Ip']).toEqual(['{http.vars.client_ip}']);
    expect(gate.headers.request.add ?? {}).not.toHaveProperty('X-Ingressi-Client-Ip');
  });

  it('strips client copies of the gate headers in every separator spelling and the X-Ingressi-Consumer-* family', async () => {
    await monetizedHost('api', 'api.example.com');
    const doc = await buildCaddyDocument();
    const strip = collectHandleArrays(doc).flat().find(isStrip) as { request: { delete: string[] } };
    for (const name of ['X-Ingressi-Consumer-Id', 'X_Ingressi_Consumer_Id', 'X-Ingressi_Plan', 'X_Ingressi_Plan', 'X-Ingressi-Consumer-*', 'X_Ingressi_Consumer_*']) {
      expect(strip.request.delete).toContain(name);
    }
  });

  it('strips a client copy of X-Ingressi-Client-Ip in every separator spelling before the upstream', async () => {
    await monetizedHost('api', 'api.example.com');
    const doc = await buildCaddyDocument();
    const strip = collectHandleArrays(doc).flat().find(isStrip) as { request: { delete: string[] } };
    for (const name of ['X-Ingressi-Client-Ip', 'X_Ingressi_Client_Ip', 'X-Ingressi_Client-Ip', 'X_Ingressi-Client_Ip']) {
      expect(strip.request.delete, name).toContain(name);
    }
  });

  it('runs the gate after redirects and path blocks, so those answer without charging', async () => {
    await monetizedHost('api', 'api.example.com', {
      redirects: [{ from: '/old', to: '/new', status: 301 }],
      pathBlocks: [{ path: '/internal/*', status: 403 }],
    });
    const doc = await buildCaddyDocument();
    const route = collectHandleArrays(doc).find((arr) => arr.some(isUpstreamProxy))!;
    const gate = route.findIndex(isGate);
    const subroutes = route.map((h, i) => ((h as Record<string, unknown>).handler === 'subroute' ? i : -1)).filter((i) => i >= 0);
    expect(subroutes.length).toBe(2);
    for (const index of subroutes) expect(index).toBeLessThan(gate);
  });

  it('leaves hosts without monetization (or with it turned off) alone', async () => {
    await createProxyHost({ name: 'plain', domains: ['plain.example.com'], upstreams: [UPSTREAM] }, 1);
    const off = await createProxyHost({ name: 'off', domains: ['off.example.com'], upstreams: [UPSTREAM] }, 1);
    await insertMonetizedHost(ctx.db, off.id, { enabled: false });
    const doc = await buildCaddyDocument();
    const handlers = collectHandleArrays(doc).flat();
    expect(handlers.some(isGate)).toBe(false);
    expect(handlers.some(isStrip)).toBe(false);
    expect(await readGateSecret()).toBeNull();
  });

  it('only gates the monetized host when others share the configuration', async () => {
    await createProxyHost({ name: 'plain', domains: ['plain.example.com'], upstreams: [UPSTREAM] }, 1);
    await monetizedHost('api', 'api.example.com');
    const doc = await buildCaddyDocument();
    const upstreamRoutes = collectHandleArrays(doc).filter((arr) => arr.some(isUpstreamProxy));
    const gated = upstreamRoutes.filter((arr) => arr.some(isGate));
    expect(gated.length).toBeGreaterThan(0);
    expect(gated.length).toBeLessThan(upstreamRoutes.length);
  });

  it('ignores monetization on a sync slave (its hosts come from the master)', async () => {
    await monetizedHost('api', 'api.example.com');
    await ctx.db.insert(schema.settings).values({ key: 'instance_mode', value: JSON.stringify('slave'), updatedAt: new Date().toISOString() });
    const doc = await buildCaddyDocument();
    expect(collectHandleArrays(doc).flat().some(isGate)).toBe(false);
  });
});

describe('access log', () => {
  it('never records an x402 payment payload', async () => {
    await monetizedHost('api', 'api.example.com');
    const t = new Date().toISOString();
    await ctx.db.insert(schema.settings).values({ key: 'logging', value: JSON.stringify({ enabled: true, format: 'json' }), updatedAt: t });
    const doc = (await buildCaddyDocument()) as Record<string, any>;
    const access = doc.logging.logs.http_access;
    expect(access.encoder.format).toBe('filter');
    expect(access.encoder.wrap).toEqual({ format: 'json' });
    expect(access.encoder.fields).toEqual({
      'request>headers>Payment-Signature': { filter: 'delete' },
      'request>headers>X-Payment': { filter: 'delete' },
    });
  });
});
