/**
 * AUTH_ALLOW_OAUTH_ROLE_FROM_CLAIMS=true opt-out of the H3 enforcement: when an
 * operator explicitly trusts their IdP, the user.create.before hook must leave
 * the IdP-provided role/status intact instead of forcing safe defaults.
 *
 * The flag is read from env at config import, so it is set in a hoisted block
 * before any imports and cleaned up afterwards. (The default-secure path is
 * covered in auth-oauth-role-injection.test.ts.)
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => {
  process.env.AUTH_ALLOW_OAUTH_ROLE_FROM_CLAIMS = 'true';
  return { db: null as unknown as TestDb };
});

afterAll(() => {
  delete process.env.AUTH_ALLOW_OAUTH_ROLE_FROM_CLAIMS;
});

vi.mock('../../src/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db');
  ctx.db = createTestDb();
  return (await import('../helpers/db-module')).mockDbModule(() => ctx.db);
});

vi.mock('better-auth', () => ({
   
  betterAuth: (options: any) => ({ options }),
}));
vi.mock('better-auth/plugins', () => ({
  genericOAuth: () => ({}),
  username: () => ({}),
}));

import { getAuth } from '../../src/lib/auth-server';

describe('OAuth role-from-claims opt-in (AUTH_ALLOW_OAUTH_ROLE_FROM_CLAIMS=true)', () => {
  it('leaves IdP-provided role/status intact instead of forcing defaults', async () => {
     
    const auth = getAuth() as any;
    const hook = auth.options.databaseHooks.user.create.before;

    const result = await hook({
      email: 'trusted@idp.example',
      name: 'Trusted',
      role: 'admin',
      status: 'active',
    });

    expect(result.data.role).toBe('admin'); // claim honored — not forced to "user"
    expect(result.data.status).toBe('active');
  });

  it.each(['user', 'viewer'])('maps a %s role claim to that built-in role, as before custom roles', async (role) => {
    const auth = getAuth() as any;
    const hook = auth.options.databaseHooks.user.create.before;
    const result = await hook({ email: `${role}@idp.example`, name: role, role, status: 'active' });
    expect(result.data.role).toBe(role);
  });

  it('never takes a custom role from the claims', async () => {
    const auth = getAuth() as any;
    const hook = auth.options.databaseHooks.user.create.before;
    const result = await hook({ email: 'teams@idp.example', name: 'Teams', role: 'user', customRoleId: 1, status: 'active' });
    expect(result.data.role).toBe('user');
    expect(result.data).not.toHaveProperty('customRoleId');
  });
});
