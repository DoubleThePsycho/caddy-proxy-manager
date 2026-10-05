/**
 * GET /api/v1/search (src/lib/search.ts), called through the real guard with
 * real API tokens and a real in-memory database: every group of results is
 * limited to what the caller may read (permission, tag scope, organisation),
 * the query is matched literally, and user results carry no secrets.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { apiRequest, insertRole, insertToken, insertUser, json, nowIso } from '../helpers/custom-roles';
import { insertTenantUser } from '../helpers/multi-tenancy';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  viewCookie: undefined as string | undefined,
}));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (name === 'organization_view' && ctx.viewCookie !== undefined ? { name, value: ctx.viewCookie } : undefined),
    set: () => {},
  }),
}));

import { GET } from '@/app/api/v1/search/route';
import { resetBrandingCache, writeBranding } from '@/ee/white-label/store';
import { DEFAULT_BRANDING_SETTINGS } from '@/ee/white-label/types';
import { auth } from '@/src/lib/auth';
import type { SearchResponse, SearchResult } from '@/src/lib/search-results';
import { first } from '@/src/lib/db/ops';

const ADMIN = 1;
const HOSTS_READER = 2;
const SCOPED = 3;
const ALPHA_ADMIN = 4;
const VIEWER = 5;
const BRAVO_USER = 6;
const SETTINGS_READER = 7;

const ORG_ALPHA = 1;
const ORG_BRAVO = 2;

const PASSWORD_HASH = '$2b$12$secretsecretsecretsecretsecretsecretsecretsecretsecret';

const tokens = new Map<number, string>();

async function organization(id: number, name: string) {
  const now = nowIso();
  await ctx.db.insert(schema.organizations).values({ id, name, slug: name.toLowerCase(), allowedUpstreams: '[]', createdAt: now, updatedAt: now });
}

async function host(name: string, domains: string[], extra: Partial<typeof schema.proxyHosts.$inferInsert> = {}) {
  const now = nowIso();
  return (await first(ctx.db.insert(schema.proxyHosts).values({
    name, domains: JSON.stringify(domains), upstreams: '["10.1.0.5:8080"]', createdAt: now, updatedAt: now, ...extra,
  }).returning()))!.id;
}

async function certificate(name: string, domains: string[], organizationId: number | null = null) {
  const now = nowIso();
  return (await first(ctx.db.insert(schema.certificates).values({
    name, type: 'managed', domainNames: JSON.stringify(domains), organizationId, createdAt: now, updatedAt: now,
  }).returning()))!.id;
}

async function search(userId: number, q: string): Promise<SearchResponse> {
  const response = await GET(apiRequest('GET', `/api/v1/search?q=${encodeURIComponent(q)}`, tokens.get(userId)!));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return json(response);
}

const groups = (results: SearchResult[]) => [...new Set(results.map((r) => r.group))];
const ids = (results: SearchResult[], group?: string) => results.filter((r) => !group || r.group === group).map((r) => r.id);
const titles = (results: SearchResult[], group: string) => results.filter((r) => r.group === group).map((r) => r.title);

let appHost = 0;
let apiHost = 0;
let alphaHost = 0;
let bravoHost = 0;
let percentHost = 0;
let underscoreHost = 0;

beforeEach(async () => {
  ctx.db = createTestDb();
  ctx.viewCookie = undefined;
  tokens.clear();
  await organization(ORG_ALPHA, 'Alpha');
  await organization(ORG_BRAVO, 'Bravo');

  await insertUser(ctx.db, ADMIN, 'admin');
  await ctx.db.update(schema.users).set({ passwordHash: PASSWORD_HASH, name: 'Ada Admin' }).where(eqId(ADMIN));
  await insertUser(ctx.db, HOSTS_READER, 'viewer', await insertRole(ctx.db, 1, ['proxy_hosts:read']));
  await insertUser(ctx.db, SCOPED, 'viewer', await insertRole(ctx.db, 2, ['proxy_hosts:read', 'certificates:read'], ['team-a']));
  await insertTenantUser(ctx.db, ALPHA_ADMIN, 'org_admin', ORG_ALPHA, null, 'user4');
  await insertUser(ctx.db, VIEWER, 'viewer');
  await insertTenantUser(ctx.db, BRAVO_USER, 'user', ORG_BRAVO, null, 'user6');
  await insertUser(ctx.db, SETTINGS_READER, 'viewer', await insertRole(ctx.db, 3, ['settings:read']));
  for (const id of [ADMIN, HOSTS_READER, SCOPED, ALPHA_ADMIN, VIEWER, BRAVO_USER, SETTINGS_READER]) tokens.set(id, await insertToken(ctx.db, id));

  appHost = await host('App', ['app.example.com'], { tags: '["team-a"]' });
  apiHost = await host('API', ['api.example.com', 'api2.example.com']);
  alphaHost = await host('Alpha site', ['alpha.example.com'], { organizationId: ORG_ALPHA });
  bravoHost = await host('Bravo site', ['bravo.example.com'], { organizationId: ORG_BRAVO });
  percentHost = await host('100% uptime', ['status.example.org']);
  underscoreHost = await host('legacy_box', ['legacy.example.org'], { enabled: false });
  const now = nowIso();
  await ctx.db.insert(schema.l4ProxyHosts).values({
    name: 'game-server', protocol: 'tcp', listenAddress: ':25565', upstreams: '["10.1.0.9:25565"]', createdAt: now, updatedAt: now,
  });
  const wildcard = await certificate('Wildcard example.com', ['*.example.com']);
  await certificate('Alpha certificate', ['alpha.example.com'], ORG_ALPHA);
  // The scoped role reaches the wildcard certificate through the team-a host using it.
  await ctx.db.update(schema.proxyHosts).set({ certificateId: wildcard }).where(eq(schema.proxyHosts.id, appHost));
});

function eqId(id: number) {
  return eq(schema.users.id, id);
}

describe('GET /api/v1/search', () => {
  it('answers 401 without credentials', async () => {
    vi.mocked(auth).mockResolvedValueOnce(null);
    const request = apiRequest('GET', '/api/v1/search?q=app', 'x');
    request.headers.delete('authorization');
    const response = await GET(request);
    expect(response.status).toBe(401);
  });

  it('gives an administrator hosts, L4 hosts, certificates, users, settings and actions', async () => {
    const hosts = await search(ADMIN, 'example.com');
    expect(ids(hosts.results, 'hosts')).toEqual(expect.arrayContaining([`proxy_host:${appHost}`, `proxy_host:${apiHost}`, `proxy_host:${alphaHost}`, `proxy_host:${bravoHost}`]));
    const app = hosts.results.find((r) => r.id === `proxy_host:${appHost}`)!;
    expect(app).toMatchObject({ title: 'app.example.com', mono: true, href: '/proxy-hosts?search=app.example.com', kind: 'proxy_host', verb: 'Open', run: null, external: false });
    expect(titles(hosts.results, 'certificates')).toContain('Wildcard example.com');
    expect(titles(hosts.results, 'users').length).toBeGreaterThan(0);

    expect(ids((await search(ADMIN, 'game')).results, 'hosts')).toEqual([expect.stringMatching(/^l4_proxy_host:/)]);
    // A settings page is found by the words of the sections it holds; a section further down it on its own.
    expect(titles((await search(ADMIN, 'geoip')).results, 'pages')).toContain('Geo blocking');
    expect(titles((await search(ADMIN, 'instance sync')).results, 'pages')).toContain('Instance sync');
    expect(titles((await search(ADMIN, 'acme')).results, 'pages')).toContain('Certificate settings');
    const dns = (await search(ADMIN, 'dns-01')).results.find((r) => r.id === 'setting:dns-providers');
    expect(dns).toMatchObject({ group: 'settings', title: 'DNS-01 providers', href: '/certificates/settings#dns-providers' });
    expect(titles((await search(ADMIN, 'redis')).results, 'settings')).toEqual(expect.arrayContaining(['Certificate storage', 'Shared state']));
    expect((await search(ADMIN, 'blocked')).results.find((r) => r.id === 'setting:blocked-sources')).toMatchObject({
      group: 'settings',
      href: '/access-lists?tab=blocked-sources',
    });
    const apply = (await search(ADMIN, 'apply')).results.find((r) => r.id === 'action:apply-config');
    expect(apply).toMatchObject({ group: 'actions', run: 'apply_config', verb: 'Run' });
    expect(titles((await search(ADMIN, 'ada')).results, 'users')).toEqual(['Ada Admin']);
  });

  it('offers to create a host for a new domain, not for one that exists', async () => {
    const fresh = await search(ADMIN, 'new.example.com');
    expect(fresh.results.find((r) => r.id === 'action:create-proxy-host:domain')).toMatchObject({
      href: '/proxy-hosts/new?domain=new.example.com',
      noHighlight: true,
    });
    const existing = await search(ADMIN, 'app.example.com');
    expect(ids(existing.results)).not.toContain('action:create-proxy-host:domain');
  });

  it('never returns a password hash or other user columns', async () => {
    const body = await search(ADMIN, 'example');
    const text = JSON.stringify(body);
    expect(text).not.toContain(PASSWORD_HASH);
    expect(text).not.toContain('passwordHash');
    for (const user of body.results.filter((r) => r.group === 'users')) {
      expect(Object.keys(user).sort()).toEqual(['external', 'group', 'href', 'id', 'kind', 'mono', 'run', 'subtitle', 'title', 'verb']);
    }
  });

  it('gives a role with only proxy_hosts:read hosts and its pages, nothing else', async () => {
    const body = await search(HOSTS_READER, 'example');
    expect(groups(body.results).filter((g) => g !== 'docs')).toEqual(['hosts']);
    expect((await search(HOSTS_READER, 'geo')).results.filter((r) => r.group === 'settings')).toEqual([]);
    expect((await search(HOSTS_READER, 'create')).results.filter((r) => r.group === 'actions')).toEqual([]);
    expect((await search(HOSTS_READER, 'game')).results.filter((r) => r.group === 'hosts')).toEqual([]);
    const pages = (await search(HOSTS_READER, 'hosts')).results.filter((r) => r.group === 'pages');
    expect(pages.map((r) => r.href)).toEqual(['/proxy-hosts']);
  });

  it('limits a tag-scoped role to hosts and certificates in its scope', async () => {
    const body = await search(SCOPED, 'example');
    expect(ids(body.results, 'hosts')).toEqual([`proxy_host:${appHost}`]);
    expect(titles(body.results, 'certificates')).toEqual(['Wildcard example.com']);
  });

  it('gives an organisation user only their organisation\'s hosts, certificates and users', async () => {
    const body = await search(ALPHA_ADMIN, 'example');
    expect(ids(body.results, 'hosts')).toEqual([`proxy_host:${alphaHost}`]);
    expect(titles(body.results, 'certificates')).toEqual(['Alpha certificate']);
    expect(ids(body.results, 'users')).toEqual([`user:${ALPHA_ADMIN}`]);
    expect((await search(ALPHA_ADMIN, 'game')).results.filter((r) => r.group === 'hosts')).toEqual([]);
    // The organisation view cookie cannot widen what an organisation user sees.
    ctx.viewCookie = 'all';
    expect(ids((await search(ALPHA_ADMIN, 'bravo')).results, 'hosts')).toEqual([]);
  });

  it('follows the organisation view a provider-level user picked', async () => {
    ctx.viewCookie = String(ORG_BRAVO);
    const body = await search(ADMIN, 'example.com');
    expect(ids(body.results, 'hosts')).toEqual([`proxy_host:${bravoHost}`]);
    expect(ids(body.results, 'users')).toEqual([`user:${BRAVO_USER}`]);
  });

  it('matches LIKE wildcards literally', async () => {
    expect(ids((await search(ADMIN, '%')).results, 'hosts')).toEqual([`proxy_host:${percentHost}`]);
    expect(ids((await search(ADMIN, '_')).results, 'hosts')).toEqual([`proxy_host:${underscoreHost}`]);
    expect((await search(ADMIN, '_')).results.find((r) => r.id === `proxy_host:${underscoreHost}`)?.subtitle).toContain('disabled');
    expect(ids((await search(ADMIN, '\\')).results, 'hosts')).toEqual([]);
  });

  it('cuts long queries and answers an empty one with suggestions', async () => {
    const long = await search(ADMIN, `  ${'a'.repeat(300)}  `);
    expect(long.query).toHaveLength(100);
    const empty = await search(ADMIN, '   ');
    expect(empty.query).toBe('');
    expect(groups(empty.results)).toEqual(['actions', 'pages']);
    expect(ids(empty.results, 'actions')[0]).toBe('action:create-proxy-host');
  });

  it('gives a token without permissions pages, profile settings and documentation only', async () => {
    const empty = await search(VIEWER, '');
    expect(empty.results.map((r) => r.href)).toEqual(['/', '/profile']);
    for (const q of ['proxy', 'example', 'token', 'apply', 'users']) {
      const body = await search(VIEWER, q);
      expect(groups(body.results).every((g) => ['pages', 'settings', 'docs'].includes(g)), q).toBe(true);
      for (const result of body.results.filter((r) => r.group === 'settings' || r.group === 'pages')) {
        expect(['/', '/profile'], `${q}: ${result.href}`).toContain(result.href);
      }
    }
    expect(titles((await search(VIEWER, 'token')).results, 'settings')).toEqual(['API tokens']);
  });

  it('shows settings sections whose own permission the role lacks to nobody but the holders', async () => {
    expect(titles((await search(SETTINGS_READER, 'geoip')).results, 'pages')).toContain('Geo blocking');
    expect(titles((await search(SETTINGS_READER, 'dns')).results, 'settings')).toContain('DNS-01 providers');
    expect(titles((await search(SETTINGS_READER, 'redis')).results, 'settings')).not.toContain('Certificate storage');
    expect(titles((await search(SETTINGS_READER, 'redis')).results, 'settings')).not.toContain('Shared state');
    expect((await search(SETTINGS_READER, 'apply')).results.filter((r) => r.group === 'actions')).toEqual([]);
  });

  it('links documentation to the published files and the API reference in the dashboard', async () => {
    const body = await search(ADMIN, 'rate limiting');
    const doc = body.results.find((r) => r.id === 'doc:rate-limiting');
    expect(doc).toMatchObject({ external: true, verb: 'Read' });
    expect(doc!.href).toMatch(/^https:\/\/github\.com\/.+\/documentation\/rate-limiting\.md$/);
    expect((await search(ADMIN, 'openapi')).results.find((r) => r.id === 'doc:api-reference')).toMatchObject({ href: '/api-docs', external: false });
    expect((await search(VIEWER, 'openapi')).results.find((r) => r.id === 'doc:api-reference')).toBeUndefined();
  });

  it('leaves external documentation out of a white-labelled dashboard', async () => {
    await writeBranding({ ...DEFAULT_BRANDING_SETTINGS, productName: 'Example Edge' }, { logoLight: null, logoDark: null, favicon: null });
    try {
      const body = await search(ADMIN, 'rate limiting');
      expect(body.results.filter((r) => r.external)).toEqual([]);
      expect((await search(ADMIN, 'openapi')).results.find((r) => r.id === 'doc:api-reference')).toBeDefined();
    } finally {
      resetBrandingCache();
    }
  });
});
