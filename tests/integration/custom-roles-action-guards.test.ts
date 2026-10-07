/**
 * Every dashboard page and server action guarded by requirePermission, called
 * through the real guard (src/lib/auth.ts) with a session of a custom-role
 * user:
 *
 *  - a role with no permission is refused, and the refusal names the
 *    permission in the call-site table (for an action built on a shared
 *    helper, one of its file's call sites);
 *  - a role with every other permission is refused the same way;
 *  - a role with just that permission gets past the guard;
 *  - the built-in user and viewer roles are refused as before.
 *
 * Server actions report a refusal differently (a thrown error, { error },
 * { ok: false, error } or an ActionState), so the outcome is searched for the
 * guard's message.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ne } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { findPermissionCallSites } from '../helpers/permission-call-sites';
import { PERMISSIONS, type Permission } from '@/src/lib/permissions';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb, sessionUserId: 0 }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
// The real guards, instead of the setup file's mock.
vi.mock('@/src/lib/auth', async (importOriginal) => importOriginal());
vi.mock('@/src/lib/auth-server', () => ({
  getAuth: () => ({
    api: {
      getSession: async () => ({ user: { id: ctx.sessionUserId }, session: { id: 1, createdAt: new Date() } }),
    },
  }),
  reloadOAuthProviders: async () => {},
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); },
  notFound: () => { throw new Error('NOT_FOUND'); },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@clickhouse/client', () => {
  const unavailable = async () => { throw new Error('ClickHouse is not available in tests'); };
  return { createClient: () => ({ query: unavailable, insert: unavailable, command: unavailable, exec: unavailable, ping: unavailable, close: async () => {} }) };
});
vi.mock('@/src/lib/l4-ports', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/l4-ports')>()),
  applyL4Ports: vi.fn(async () => ({ state: 'idle' })),
}));

const NO_PERMISSIONS = 1;
const ALL_BUT = 2;
const ONLY = 3;
const USERS = { none: 21, allBut: 22, only: 23, user: 24, viewer: 25 } as const;

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

function including(permission: Permission): Set<string> {
  const area = permission.slice(0, permission.indexOf(':'));
  return permission.endsWith(':read')
    ? new Set(PERMISSIONS.filter((candidate) => candidate.startsWith(`${area}:`)))
    : new Set([permission]);
}

async function rolesFor(permission: Permission) {
  await ctx.db.delete(schema.customRoles).where(ne(schema.customRoles.id, NO_PERMISSIONS));
  const excluded = including(permission);
  await insertRole(ALL_BUT, PERMISSIONS.filter((candidate) => !excluded.has(candidate)));
  const read = `${permission.split(':')[0]}:read`;
  await insertRole(ONLY, [permission, ...((PERMISSIONS as readonly string[]).includes(read) && read !== permission ? [read] : [])]);
}

const DENIED = /Permission required: ([a-z0-9_]+:[a-z]+)/;
const LEGACY_DENIED = /Administrator privileges required/;

/** Calls an export as `userId` and returns everything it said: the result or the error, as text. */
async function outcome(fn: (...args: unknown[]) => unknown, isPage: boolean, userId: number): Promise<string> {
  ctx.sessionUserId = userId;
  const form = new FormData();
  const args = isPage
    ? [{ searchParams: Promise.resolve({}), params: Promise.resolve({}) }]
    : [1, form, form];
  try {
    const result = await fn(...args);
    try {
      return JSON.stringify(result) ?? '';
    } catch {
      return 'rendered';
    }
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
}

// Dashboard pages (their app/ files, routed into ee/ for ee/ features) and server actions, ee/ ones in ee/<feature>/ui/.
const sites = findPermissionCallSites().filter((site) => site.file.startsWith('app/(dashboard)/') || /^ee\/.+\/ui\//.test(site.file));
const files = [...new Set(sites.map((site) => site.file))];

beforeEach(async () => {
  ctx.db = createTestDb();
  await insertRole(NO_PERMISSIONS, []);
  await insertUser(10, 'admin', null);
  await insertUser(USERS.none, 'viewer', NO_PERMISSIONS);
  await insertUser(USERS.allBut, 'viewer', ALL_BUT);
  await insertUser(USERS.only, 'viewer', ONLY);
  await insertUser(USERS.user, 'user', null);
  await insertUser(USERS.viewer, 'viewer', null);
});

describe('dashboard permission guards', () => {
  it('covers the dashboard call sites', () => {
    expect(sites.length).toBeGreaterThan(90);
  });

  it.each(files)('%s', async (file) => {
    const mod = await import(/* @vite-ignore */ `../../${file}`);
    const fileSites = sites.filter((site) => site.file === file);
    const filePermissions = new Set(fileSites.map((site) => site.permission));
    const exported = Object.entries(mod).filter(([, value]) => typeof value === 'function') as Array<[string, (...args: unknown[]) => unknown]>;
    const exercised = new Set<string>();

    for (const [name, fn] of exported) {
      const isPage = name === 'default';
      // A custom role without permissions learns which permission the export needs.
      const refused = await outcome(fn, isPage, USERS.none);
      const match = refused.match(DENIED);
      expect(match, `${file} ${name} is not guarded: ${refused.slice(0, 200)}`).not.toBeNull();
      const permission = match![1] as Permission;
      const direct = fileSites.find((site) => site.fn === name || (isPage && /Page$/.test(site.fn)));
      if (direct) expect(permission, `${file} ${name}`).toBe(direct.permission);
      else expect(filePermissions.has(permission), `${file} ${name} checked ${permission}`).toBe(true);
      exercised.add(permission);

      await rolesFor(permission);
      expect((await outcome(fn, isPage, USERS.allBut)).match(DENIED)?.[1], `${file} ${name}`).toBe(permission);
      for (const builtIn of [USERS.user, USERS.viewer]) {
        expect(await outcome(fn, isPage, builtIn), `${file} ${name}`).toMatch(LEGACY_DENIED);
      }
      const allowed = await outcome(fn, isPage, USERS.only);
      expect(allowed, `${file} ${name} as a role with ${permission}`).not.toMatch(DENIED);
      expect(allowed).not.toMatch(LEGACY_DENIED);
    }

    // Every permission the file's call sites name is reached through some export.
    expect([...filePermissions].filter((permission) => !exercised.has(permission)), file).toEqual([]);
  }, 60_000);
});
