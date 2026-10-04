/**
 * API token scopes through the real guard (src/lib/api-auth.ts), the real
 * role resolution (ee/custom-roles) and the real token model:
 *
 *  - every REST handler guarded by requireApiPermission refuses an
 *    administrator's token whose scopes leave its permission out, and lets
 *    one scoped to just that permission through;
 *  - a scope never adds a permission the owner does not hold;
 *  - endpoints for the owner's own account refuse a token with scopes, and
 *    a scoped token is never an administrator;
 *  - creating a token checks the scopes against the owner's role, stores them
 *    and validateToken hands them to the guard; unreadable stored scopes
 *    allow nothing;
 *  - organizationForNewRow (ee/multi-tenancy), which reads the actor's access
 *    again from its id, applies the request's token scopes too.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { findPermissionCallSites, type CallSite } from '../helpers/permission-call-sites';
import { PERMISSIONS, type Permission } from '@/src/lib/permissions';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  /** Bearer token -> the user it authenticates and its scopes. */
  tokens: new Map<string, { user: { id: number; role: string; customRoleId: number | null }; scopes: string[] | null }>(),
  /** What next/headers returns to code that reads the request's headers. */
  requestHeaders: new Headers(),
}));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('@/src/lib/models/api-tokens', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/src/lib/models/api-tokens')>();
  return {
    ...original,
    validateToken: vi.fn(async (raw: string) => {
      const entry = ctx.tokens.get(raw);
      if (entry) return { token: { id: 1, name: 'test', createdBy: entry.user.id, scopes: entry.scopes }, user: entry.user };
      return original.validateToken(raw);
    }),
  };
});
vi.mock('next/headers', () => ({ headers: async () => ctx.requestHeaders }));
vi.mock('@clickhouse/client', () => {
  const unavailable = async () => { throw new Error('ClickHouse is not available in tests'); };
  return { createClient: () => ({ query: unavailable, insert: unavailable, command: unavailable, exec: unavailable, ping: unavailable, close: async () => {} }) };
});
vi.mock('@/src/lib/l4-ports', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/l4-ports')>()),
  applyL4Ports: vi.fn(async () => ({ state: 'idle' })),
  getL4PortsDiff: vi.fn(async () => ({ required: [], applied: [], changed: false })),
  getL4PortsStatus: vi.fn(() => ({ state: 'idle' })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const ADMIN = 10;
const CUSTOM = 11;
const ROLE = 1;

async function insertUser(id: number, role: string, customRoleId: number | null) {
  const now = new Date().toISOString();
  await ctx.db.insert(schema.users).values({
    id, email: `user${id}@example.com`, name: `User ${id}`, role, customRoleId, provider: 'credentials',
    subject: `user${id}@example.com`, status: 'active', createdAt: now, updatedAt: now,
  });
}

/** The permissions that, held, include `permission` (an area's read comes with its write). */
function including(permission: Permission): Set<string> {
  const area = permission.slice(0, permission.indexOf(':'));
  return permission.endsWith(':read')
    ? new Set(PERMISSIONS.filter((candidate) => candidate.startsWith(`${area}:`)))
    : new Set([permission]);
}

function request(method: string, token: string, path: string, body: unknown = {}): any {
  const url = new URL(`https://dash.example.com${path}`);
  return {
    method,
    url: url.toString(),
    headers: new Headers({ authorization: `Bearer ${token}`, 'content-type': 'application/json' }),
    nextUrl: url,
    cookies: { get: () => undefined },
    json: async () => body,
    text: async () => JSON.stringify(body),
    formData: async () => new FormData(),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function params(site: CallSite): { params: Promise<Record<string, string>> } {
  const values: Record<string, string> = new Proxy({}, { get: (_target, key) => (typeof key === 'string' ? '1' : undefined) });
  if (site.file.includes('settings/[group]')) {
    const area = site.permission.split(':')[0];
    const group = area === 'instances' ? 'instance-mode' : area === 'waf' ? 'waf' : 'general';
    return { params: Promise.resolve({ group }) };
  }
  if (site.file.includes('[token]')) return { params: Promise.resolve({ token: 'not-a-token' }) };
  return { params: Promise.resolve(values) };
}

async function callHandler(file: string, fn: string, token: string, routeParams: Record<string, string> = {}, body: unknown = {}) {
  const mod = await import(/* @vite-ignore */ `../../${file}`);
  const handler = mod[fn] as (req: unknown, context: unknown) => Promise<Response>;
  const path = '/' + file.replace(/^app\//, '').replace(/\/route\.ts$/, '').replace(/\[[^\]]+\]/g, '1');
  const response = await handler(request(fn, token, path, body), { params: Promise.resolve(routeParams) });
  let error: string | null;
  try {
    const parsed = await response.clone().json();
    error = typeof parsed?.error === 'string' ? parsed.error : null;
  } catch {
    error = null;
  }
  return { status: response.status, error };
}

async function call(site: CallSite, token: string) {
  const mod = await import(/* @vite-ignore */ `../../${site.file}`);
  const handler = mod[site.fn] as (req: unknown, context: unknown) => Promise<Response>;
  const path = '/' + site.file.replace(/^app\//, '').replace(/\/route\.ts$/, '').replace(/\[[^\]]+\]/g, '1');
  const response = await handler(request(site.fn, token, path), params(site));
  let error: string | null;
  try {
    const body = await response.clone().json();
    error = typeof body?.error === 'string' ? body.error : null;
  } catch {
    error = null;
  }
  return { status: response.status, error };
}

const routeSites = findPermissionCallSites().filter((site) => site.file.startsWith('app/api/'));

beforeEach(async () => {
  ctx.db = createTestDb();
  ctx.requestHeaders = new Headers();
  await insertUser(ADMIN, 'admin', null);
  const now = new Date().toISOString();
  await ctx.db.insert(schema.customRoles).values({
    id: ROLE, name: 'Operators', permissions: JSON.stringify(['proxy_hosts:read', 'proxy_hosts:write']), scopeTags: '[]',
    createdAt: now, updatedAt: now,
  });
  await insertUser(CUSTOM, 'viewer', ROLE);
});

describe('scoped tokens on every guarded REST handler', () => {
  beforeAll(() => {
    ctx.tokens.clear();
  });

  it('covers the REST call sites', () => {
    expect(routeSites.length).toBeGreaterThan(150);
  });

  it.each(routeSites.map((site) => [`${site.fn} ${site.file} (${site.permission})`, site] as const))(
    '%s',
    async (_name, site) => {
      const permission = site.permission as Permission;
      const excluded = including(permission);
      ctx.tokens.set('admin-all-but', {
        user: { id: ADMIN, role: 'admin', customRoleId: null },
        scopes: PERMISSIONS.filter((candidate) => !excluded.has(candidate)),
      });
      ctx.tokens.set('admin-only', { user: { id: ADMIN, role: 'admin', customRoleId: null }, scopes: [permission] });
      // An owner who lacks the permission gets nothing from a scope naming it.
      ctx.tokens.set('owner-lacks', { user: { id: CUSTOM, role: 'viewer', customRoleId: ROLE }, scopes: [permission] });

      const denied = await call(site, 'admin-all-but');
      expect(denied.status).toBe(403);
      expect(denied.error).toBe(`This API token's scopes do not include ${permission}`);

      if (permission !== 'proxy_hosts:read' && permission !== 'proxy_hosts:write') {
        const ownerLacks = await call(site, 'owner-lacks');
        expect(ownerLacks.status).toBe(403);
        expect(ownerLacks.error).toBe(`Permission required: ${permission}`);
      }

      const allowed = await call(site, 'admin-only');
      expect(allowed.status).not.toBe(401);
      expect(allowed.error ?? '').not.toMatch(/^Permission required|^Administrator privileges required|scopes do not include|limited to its scopes/);
    },
    20_000
  );
});

describe('endpoints for the owner\'s own account', () => {
  const SELF_SERVICE: Array<[string, string]> = [
    ['app/api/v1/sessions/route.ts', 'GET'],
    ['app/api/v1/sessions/route.ts', 'DELETE'],
    ['app/api/v1/sessions/[id]/route.ts', 'DELETE'],
    ['app/api/v1/tokens/route.ts', 'GET'],
    ['app/api/v1/tokens/route.ts', 'POST'],
    ['app/api/v1/tokens/[id]/route.ts', 'DELETE'],
    ['app/api/v1/passkeys/route.ts', 'GET'],
    ['app/api/v1/passkeys/[id]/route.ts', 'PATCH'],
    ['app/api/v1/passkeys/[id]/route.ts', 'DELETE'],
    ['app/api/v1/preferences/route.ts', 'GET'],
    ['app/api/v1/preferences/route.ts', 'PUT'],
    ['app/api/v1/mfa/route.ts', 'GET'],
    ['app/api/v1/access-review-assignments/route.ts', 'GET'],
  ];

  it.each(SELF_SERVICE)('%s %s refuses a token with scopes, even one with every permission', async (file, fn) => {
    ctx.tokens.set('everything', { user: { id: ADMIN, role: 'admin', customRoleId: null }, scopes: [...PERMISSIONS] });
    ctx.tokens.set('unscoped', { user: { id: ADMIN, role: 'admin', customRoleId: null }, scopes: null });
    const refused = await callHandler(file, fn, 'everything', { id: '1' });
    expect(refused.status).toBe(403);
    expect(refused.error).toMatch(/limited to its scopes/);
    const unscoped = await callHandler(file, fn, 'unscoped', { id: '1' });
    expect(unscoped.error ?? '').not.toMatch(/limited to its scopes/);
  });

  it('lets a scoped token read the DNS provider catalogue, which is about no account', async () => {
    ctx.tokens.set('narrow', { user: { id: ADMIN, role: 'admin', customRoleId: null }, scopes: ['certificates:read'] });
    expect((await callHandler('app/api/v1/dns-providers/route.ts', 'GET', 'narrow')).status).toBe(200);
  });

  it('shows a user only through users:read, never the owner through a scoped token', async () => {
    ctx.tokens.set('narrow', { user: { id: ADMIN, role: 'admin', customRoleId: null }, scopes: ['certificates:read'] });
    ctx.tokens.set('users', { user: { id: ADMIN, role: 'admin', customRoleId: null }, scopes: ['users:read'] });
    expect((await callHandler('app/api/v1/users/[id]/route.ts', 'GET', 'narrow', { id: String(ADMIN) })).status).toBe(403);
    expect((await callHandler('app/api/v1/users/[id]/mfa/route.ts', 'GET', 'narrow', { id: String(ADMIN) })).status).toBe(403);
    expect((await callHandler('app/api/v1/users/[id]/route.ts', 'GET', 'users', { id: String(ADMIN) })).status).toBe(200);
  });

  it('is never an administrator', async () => {
    ctx.tokens.set('everything', { user: { id: ADMIN, role: 'admin', customRoleId: null }, scopes: [...PERMISSIONS] });
    const { requireApiAdmin, getApiAccess, authenticateApiRequest } = await import('@/src/lib/api-auth');
    await expect(requireApiAdmin(request('GET', 'everything', '/api/v1/test'))).rejects.toMatchObject({ status: 403 });
    const result = await authenticateApiRequest(request('GET', 'everything', '/api/v1/test'));
    expect((await getApiAccess(result)).isAdmin).toBe(false);
  });
});

describe('the token model', () => {
  it('checks scopes against the owner\'s role, stores them and hands them to the guard', async () => {
    const { createApiToken, validateToken, listApiTokens } = await import('@/src/lib/models/api-tokens');
    await expect(createApiToken('ops', CUSTOM, undefined, { scopes: ['certificates:read'] })).rejects.toThrow(/does not hold/);
    await expect(createApiToken('ops', CUSTOM, undefined, { scopes: [] })).rejects.toThrow(/at least one/);
    await expect(createApiToken('ops', CUSTOM, undefined, { scopes: ['proxy_hosts:delete'] })).rejects.toThrow(/Unknown permission/);

    const { token, rawToken } = await createApiToken('ops', CUSTOM, undefined, { scopes: ['proxy_hosts:read'] });
    expect(token.scopes).toEqual(['proxy_hosts:read']);
    expect((await listApiTokens(CUSTOM))[0].scopes).toEqual(['proxy_hosts:read']);
    expect((await validateToken(rawToken))?.token.scopes).toEqual(['proxy_hosts:read']);

    const unscoped = await createApiToken('all', ADMIN);
    expect(unscoped.token.scopes).toBeNull();
  });

  it('lets a token whose stored scopes cannot be read do nothing', async () => {
    const { createApiToken } = await import('@/src/lib/models/api-tokens');
    const { rawToken, token } = await createApiToken('broken', ADMIN, undefined, { scopes: ['proxy_hosts:read'] });
    await ctx.db.update(schema.apiTokens).set({ scopes: '{"all":true}' }).where(eq(schema.apiTokens.id, token.id));
    const result = await callHandler('app/api/v1/proxy-hosts/route.ts', 'GET', rawToken);
    expect(result.status).toBe(403);
  });
});

describe('organizationForNewRow', () => {
  it('applies the scopes of the request\'s token when it reads the actor\'s access again', async () => {
    const { createApiToken } = await import('@/src/lib/models/api-tokens');
    const { organizationForNewRow } = await import('@/ee/multi-tenancy/scope');
    const { rawToken } = await createApiToken('hosts only', ADMIN, undefined, { scopes: ['proxy_hosts:write'] });

    ctx.requestHeaders = new Headers({ authorization: `Bearer ${rawToken}` });
    await expect(organizationForNewRow(ADMIN, 999)).rejects.toThrow(/organizations:write/);

    // A session (no token) or a token without scopes reaches the next check: the organisation does not exist.
    ctx.requestHeaders = new Headers();
    await expect(organizationForNewRow(ADMIN, 999)).rejects.toThrow(/Unknown organisation/);
    const { rawToken: unscoped } = await createApiToken('everything', ADMIN);
    ctx.requestHeaders = new Headers({ authorization: `Bearer ${unscoped}` });
    await expect(organizationForNewRow(ADMIN, 999)).rejects.toThrow(/Unknown organisation/);
  });
});
