/**
 * Every REST handler guarded by requireApiPermission, called through the real
 * guard (src/lib/api-auth.ts) and the real role resolution (ee/custom-roles)
 * with an API token of a custom-role user:
 *
 *  - denied (403 "Permission required: <permission>") for a role holding every
 *    permission except the one in the call-site table;
 *  - let through for a role holding just that permission (whatever the
 *    handler then answers, it is not the guard's 401/403);
 *  - denied for the built-in user and viewer roles, as before custom roles.
 *
 * The call sites come from the code (tests/helpers/permission-call-sites.ts),
 * which tests/unit/permission-call-sites.test.ts keeps equal to the table in
 * ee/docs/custom-roles.md.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { findPermissionCallSites, type CallSite } from '../helpers/permission-call-sites';
import { PERMISSIONS, type Permission } from '@/src/lib/permissions';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  /** Bearer token -> the user it authenticates. */
  tokens: new Map<string, { id: number; role: string; customRoleId: number | null }>(),
}));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('@/src/lib/models/api-tokens', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/models/api-tokens')>()),
  validateToken: vi.fn(async (raw: string) => {
    const user = ctx.tokens.get(raw);
    return user ? { token: { id: 1, name: 'test', createdBy: user.id }, user } : null;
  }),
}));
// Nothing here may reach the network or the host's filesystem.
vi.mock('@clickhouse/client', () => {
  const unavailable = async () => { throw new Error('ClickHouse is not available in tests'); };
  return { createClient: () => ({ query: unavailable, insert: unavailable, command: unavailable, exec: unavailable, ping: unavailable, close: async () => {} }) };
});
// The certificates page and overview read Caddy's certificates over TLS; no network here.
vi.mock('@/src/lib/managed-certificates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/managed-certificates')>()),
  getManagedCertificateExpiry: vi.fn(async () => new Map()),
}));
vi.mock('@/src/lib/l4-ports', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/l4-ports')>()),
  applyL4Ports: vi.fn(async () => ({ state: 'idle' })),
  getL4PortsDiff: vi.fn(async () => ({ required: [], applied: [], changed: false })),
  getL4PortsStatus: vi.fn(() => ({ state: 'idle' })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const ROLE_ALL_BUT = 1;
const ROLE_ONLY = 2;

async function insertRole(id: number, permissions: readonly string[]) {
  const now = new Date().toISOString();
  await ctx.db.insert(schema.customRoles).values({
    id, name: `role-${id}`, permissions: JSON.stringify(permissions), scopeTags: '[]', createdAt: now, updatedAt: now,
  });
}

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

/** Sets up the two custom roles for `permission` and returns the tokens. */
async function rolesFor(permission: Permission) {
  await ctx.db.delete(schema.customRoles);
  const excluded = including(permission);
  await insertRole(ROLE_ALL_BUT, PERMISSIONS.filter((candidate) => !excluded.has(candidate)));
  await insertRole(ROLE_ONLY, [permission, ...(permission.endsWith(':read') ? [] : [`${permission.split(':')[0]}:read`])]
    .filter((candidate) => (PERMISSIONS as readonly string[]).includes(candidate)));
}

function request(method: string, token: string, path: string): any {
  const url = new URL(`https://dash.example.com${path}`);
  return {
    method,
    url: url.toString(),
    headers: new Headers({ authorization: `Bearer ${token}`, 'content-type': 'application/json' }),
    nextUrl: url,
    cookies: { get: () => undefined },
    json: async () => ({}),
    text: async () => '{}',
    formData: async () => new FormData(),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

/** Route params: "1" for every segment, and the settings group that belongs to the permission. */
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

async function call(site: CallSite, token: string): Promise<{ status: number; error: string | null }> {
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

beforeAll(() => {
  ctx.tokens.set('all-but', { id: 11, role: 'viewer', customRoleId: ROLE_ALL_BUT });
  ctx.tokens.set('only', { id: 12, role: 'viewer', customRoleId: ROLE_ONLY });
  ctx.tokens.set('user', { id: 13, role: 'user', customRoleId: null });
  ctx.tokens.set('viewer', { id: 14, role: 'viewer', customRoleId: null });
});

beforeEach(async () => {
  ctx.db = createTestDb();
  await insertUser(10, 'admin', null);
  await insertUser(11, 'viewer', ROLE_ALL_BUT);
  await insertUser(12, 'viewer', ROLE_ONLY);
  await insertUser(13, 'user', null);
  await insertUser(14, 'viewer', null);
});

describe('REST permission guards', () => {
  it('covers the REST call sites', () => {
    expect(routeSites.length).toBeGreaterThan(150);
  });

  it.each(routeSites.map((site) => [`${site.fn} ${site.file} (${site.permission})`, site] as const))(
    '%s',
    async (_name, site) => {
      await rolesFor(site.permission as Permission);

      const denied = await call(site, 'all-but');
      expect(denied.status).toBe(403);
      expect(denied.error).toBe(`Permission required: ${site.permission}`);

      for (const builtIn of ['user', 'viewer']) {
        const legacy = await call(site, builtIn);
        expect(legacy.status).toBe(403);
        expect(legacy.error).toBe('Administrator privileges required');
      }

      const allowed = await call(site, 'only');
      expect(allowed.status).not.toBe(401);
      expect(allowed.error ?? '').not.toMatch(/^Permission required|^Administrator privileges required/);
    },
    20_000
  );
});
