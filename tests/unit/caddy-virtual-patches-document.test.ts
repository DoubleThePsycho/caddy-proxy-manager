/**
 * Virtual patches in the generated Caddy document (buildCaddyDocument): the
 * patches that are on, rendered in their mode, in the WAF handler of every
 * host where the WAF runs and nowhere else; patches that are off are left
 * out, and no license is consulted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

// Models and settings before src/lib/caddy (see the caddy test mock import order note).
import { createProxyHost } from '../../src/lib/models/proxy-hosts';
import { installVerifiedPacks, updatePatchMode } from '../../ee/rule-feed/store';
import { verifyRuleFeed } from '../../ee/rule-feed/feed';
import { buildCaddyDocument } from '../../src/lib/caddy';
import * as schema from '../../src/lib/db/schema';
import { createFeedSigner, examplePacks, signFeed } from '../helpers/rule-feed';

type Handler = Record<string, any>;
type Doc = Awaited<ReturnType<typeof buildCaddyDocument>>;

function wafDirectives(doc: Doc, domain: string): string | null {
  const routes = (doc.apps as any).http.servers.ingressi.routes as Array<Record<string, any>>;
  const route = routes.find((item) => item.match?.[0]?.host?.includes(domain) && !item.match[0].expression && !item.match[0].path);
  expect(route, `route of ${domain}`).toBeDefined();
  // WebSocket hosts (the default) wrap the WAF handler in a subroute.
  const find = (handlers: Handler[]): Handler | undefined => {
    for (const handler of handlers) {
      if (handler.handler === 'waf') return handler;
      for (const nested of handler.routes ?? []) {
        const found = find(nested.handle ?? []);
        if (found) return found;
      }
    }
    return undefined;
  };
  const waf = find(route!.handle as Handler[]);
  return waf ? String(waf.directives) : null;
}

async function installExamples() {
  const signer = createFeedSigner();
  const now = Date.now();
  const document = signFeed(signer, {
    v: 1, kid: signer.kid, sequence: 1, issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString(), packs: examplePacks(),
  });
  await installVerifiedPacks(verifyRuleFeed(document, signer.keys, new Date()), { autoBlockCritical: false });
}

beforeEach(async () => {
  for (const table of [schema.proxyHosts, schema.virtualPatches, schema.settings]) await ctx.db.delete(table);
  await ctx.db.delete(schema.users).catch(() => {});
  await ctx.db.insert(schema.users).values({
    id: 1, email: 'admin@example.com', name: 'Admin', role: 'admin', provider: 'credentials', subject: 'admin',
    status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
});

describe('virtual patches in buildCaddyDocument', () => {
  it('go into the WAF handler of every host where the WAF runs, in their mode', async () => {
    await createProxyHost(
      { name: 'Shop', domains: ['shop.example.com'], upstreams: ['10.0.0.5:8080'], waf: { enabled: true, waf_mode: 'override', mode: 'On', load_owasp_crs: false } },
      1
    );
    await createProxyHost(
      { name: 'Wiki', domains: ['wiki.example.com'], upstreams: ['10.0.0.6:8080'], waf: { enabled: true, waf_mode: 'override', mode: 'DetectionOnly', load_owasp_crs: true } },
      1
    );
    await createProxyHost({ name: 'Plain', domains: ['plain.example.com'], upstreams: ['10.0.0.7:8080'] }, 1);
    await installExamples();
    await updatePatchMode('ivp-2021-44228', 'block');
    await updatePatchMode('ivp-2021-41773', 'off');

    const doc = await buildCaddyDocument();
    const shop = wafDirectives(doc, 'shop.example.com')!;
    expect(shop.split('\n').find((line) => line.includes('id:1800000101'))).toContain('deny,status:403');
    expect(shop.split('\n').find((line) => line.includes('id:1800000301'))).toContain(',pass,');
    expect(shop).not.toContain('id:1800000201');
    // A host in detection only gets the same rules; its engine only logs.
    const wiki = wafDirectives(doc, 'wiki.example.com')!;
    expect(wiki).toContain('id:1800000101');
    expect(wiki).toContain('SecRuleEngine DetectionOnly');
    expect(wiki.indexOf('id:1800000101')).toBeLessThan(wiki.indexOf('Include @owasp_crs/*.conf'));
    // No WAF, no patches.
    expect(wafDirectives(doc, 'plain.example.com')).toBeNull();
  });

  it('adds nothing while every patch is off', async () => {
    await createProxyHost(
      { name: 'Shop', domains: ['shop.example.com'], upstreams: ['10.0.0.5:8080'], waf: { enabled: true, waf_mode: 'override', mode: 'On', load_owasp_crs: false } },
      1
    );
    await installExamples();
    for (const id of ['ivp-2021-44228', 'ivp-2021-41773', 'ivp-2022-22965']) await updatePatchMode(id, 'off');
    const doc = await buildCaddyDocument();
    expect(wafDirectives(doc, 'shop.example.com')).not.toContain('virtual-patch');
  });
});
