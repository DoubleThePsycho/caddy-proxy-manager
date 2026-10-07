/**
 * Enforced SSO lockout guards on user management: while SSO is enforced with
 * a break-glass administrator (an active administrator that can sign in with
 * a password), no change through the user model, the Users page actions or
 * /api/v1/users may take away the last one by accident. Break-glass accounts
 * are optional: once the account is off the list, the change goes through.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { createTestDb, disableForeignKeys, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  actorId: 1,
}));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/src/lib/auth', () => ({
  auth: vi.fn(),
  requirePermission: vi.fn(() => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireAdmin())),
  requireAdmin: vi.fn(async () => ({ user: { id: String(ctx.actorId), role: 'admin' } })),
}));
vi.mock('@/src/lib/api-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/api-auth')>()),
  requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
  requireApiAdmin: vi.fn(async () => ({ userId: ctx.actorId, role: 'admin', authMethod: 'bearer' })),
}));

import * as userModel from '@/src/lib/models/user';
import { deleteUserAction, updateUserRoleAction, updateUserStatusAction } from '@/app/(dashboard)/users/actions';
import { DELETE, PUT } from '@/app/api/v1/users/[id]/route';
import {
  BreakGlassGuardError,
  LAST_BREAK_GLASS_ADMIN_MESSAGE,
  readSsoEnforcement,
  writeSsoEnforcement,
} from '@/ee/sso/enforcement-store';
import { first } from '@/src/lib/db/ops';

const HASH = bcrypt.hashSync('Correct-Horse-9!', 4);
const ids = { actor: 0, glass: 0, glass2: 0, plain: 0 };

async function seed(username: string, role: 'admin' | 'user' = 'admin') {
  return (await userModel.createUser({
    email: `${username}@example.com`, username, role, provider: 'credentials', subject: username, passwordHash: HASH,
  })).id;
}

async function enforce(enabled: boolean, breakGlassUserIds: number[]) {
  await writeSsoEnforcement(ctx.db, { enabled, breakGlassUserIds });
}

async function userRow(id: number) {
  return await first(ctx.db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1));
}

beforeEach(async () => {
  ctx.db = createTestDb();
  await disableForeignKeys(ctx.db);
  ids.actor = await seed('actor');
  ids.glass = await seed('glass');
  ids.glass2 = await seed('glass2');
  ids.plain = await seed('plain');
  ctx.actorId = ids.actor;
});

describe('user model guards', () => {
  it('refuses demoting, disabling or deleting the only valid break-glass administrator', async () => {
    await enforce(true, [ids.glass]);
    await expect(userModel.updateUserRole(ids.glass, 'user')).rejects.toBeInstanceOf(BreakGlassGuardError);
    await expect(userModel.updateUserRole(ids.glass, 'viewer')).rejects.toThrow(LAST_BREAK_GLASS_ADMIN_MESSAGE);
    await expect(userModel.updateUserStatus(ids.glass, 'disabled')).rejects.toBeInstanceOf(BreakGlassGuardError);
    await expect(userModel.deleteUser(ids.glass)).rejects.toBeInstanceOf(BreakGlassGuardError);
    expect(await userRow(ids.glass)).toMatchObject({ role: 'admin', status: 'active' });
  });

  it('allows the same changes when another valid break-glass administrator remains', async () => {
    await enforce(true, [ids.glass, ids.glass2]);
    await userModel.updateUserRole(ids.glass, 'user');
    expect((await userRow(ids.glass))?.role).toBe('user');
    await expect(userModel.updateUserStatus(ids.glass2, 'disabled')).rejects.toBeInstanceOf(BreakGlassGuardError);
  });

  it('counts only accounts that can still sign in with a password', async () => {
    await enforce(true, [ids.glass, ids.glass2]);
    await ctx.db.update(schema.accounts).set({ password: null }).where(eq(schema.accounts.userId, ids.glass2));
    await expect(userModel.deleteUser(ids.glass)).rejects.toBeInstanceOf(BreakGlassGuardError);
  });

  it('leaves changes alone while enforcement is off, and for accounts that are not break-glass', async () => {
    await enforce(false, [ids.glass]);
    await userModel.updateUserRole(ids.glass, 'user');
    await enforce(true, [ids.glass2]);
    await userModel.updateUserStatus(ids.plain, 'disabled');
    await userModel.deleteUser(ids.plain);
    expect(await userRow(ids.plain)).toBeUndefined();
  });

  it('allows changes that cannot make things worse when no valid break-glass administrator is left', async () => {
    await enforce(true, [ids.glass]);
    await ctx.db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, ids.glass));
    await userModel.updateUserRole(ids.glass, 'viewer');
    expect((await userRow(ids.glass))?.role).toBe('viewer');
  });

  it('allows the changes once the account is off the break-glass list, also with none left', async () => {
    await enforce(true, [ids.glass]);
    await expect(userModel.deleteUser(ids.glass)).rejects.toBeInstanceOf(BreakGlassGuardError);
    await enforce(true, []);
    await userModel.updateUserRole(ids.glass, 'user');
    await userModel.updateUserStatus(ids.glass, 'disabled');
    await userModel.deleteUser(ids.glass);
    expect(await userRow(ids.glass)).toBeUndefined();
    expect(await readSsoEnforcement(ctx.db)).toEqual({ enabled: true, breakGlassUserIds: [] });
  });

  it('removes a deleted account from the break-glass list', async () => {
    await enforce(true, [ids.glass, ids.glass2]);
    await userModel.deleteUser(ids.glass);
    expect(await readSsoEnforcement(ctx.db)).toEqual({ enabled: true, breakGlassUserIds: [ids.glass2] });
  });

  it('keeps an account break-glass across a rename', async () => {
    await enforce(true, [ids.glass]);
    await userModel.setUserSignInUsername(ids.glass, 'renamed');
    expect((await readSsoEnforcement(ctx.db)).breakGlassUserIds).toEqual([ids.glass]);
    await expect(userModel.deleteUser(ids.glass)).rejects.toBeInstanceOf(BreakGlassGuardError);
  });
});

describe('Users page actions', () => {
  it('return the guard message instead of throwing', async () => {
    await enforce(true, [ids.glass]);
    const refused = { ok: false, error: LAST_BREAK_GLASS_ADMIN_MESSAGE };
    expect(await updateUserRoleAction(ids.glass, 'user')).toEqual(refused);
    expect(await updateUserStatusAction(ids.glass, 'disabled')).toEqual(refused);
    expect(await deleteUserAction(ids.glass)).toEqual(refused);
    expect(await userRow(ids.glass)).toMatchObject({ role: 'admin', status: 'active' });
  });
});

describe('/api/v1/users/{id}', () => {
  function request(method: string, body?: unknown): any {
    return {
      method,
      headers: { get: () => null },
      nextUrl: { pathname: '/api/v1/users/x', searchParams: new URLSearchParams() },
      json: async () => body ?? {},
    };
  }
  const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

  it('refuses a combined update before writing any field', async () => {
    await enforce(true, [ids.glass]);
    const response = await PUT(request('PUT', { name: 'Changed', role: 'admin', status: 'disabled' }), params(ids.glass));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(LAST_BREAK_GLASS_ADMIN_MESSAGE);
    expect(await userRow(ids.glass)).toMatchObject({ name: null, status: 'active' });
  });

  it('refuses deleting the only valid break-glass administrator', async () => {
    await enforce(true, [ids.glass]);
    const response = await DELETE(request('DELETE'), params(ids.glass));
    expect(response.status).toBe(400);
    expect(await userRow(ids.glass)).toBeDefined();
  });

  it('accepts the update once another break-glass administrator exists', async () => {
    await enforce(true, [ids.glass, ids.glass2]);
    const response = await PUT(request('PUT', { role: 'user' }), params(ids.glass));
    expect(response.status).toBe(200);
    expect((await userRow(ids.glass))?.role).toBe('user');
  });
});
