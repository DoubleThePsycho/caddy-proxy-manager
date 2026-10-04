/**
 * Regression (#261): OAuth account linking/unlinking was not reflected in the
 * Ingressi user state. Better Auth writes federated identities to the `accounts`
 * table only, while the Profile UI (and admin user list) read the informational
 * `users.provider` / `users.subject` columns:
 *
 *   - auto-link / profile "Link <provider>" created a working accounts row but
 *     left users.provider/subject empty, so the Profile page showed the account
 *     as NOT linked even though OAuth sign-in worked;
 *   - unlinking deleted the accounts rows but left users.provider/subject
 *     populated, so the Profile page kept claiming the account was linked.
 *
 * These tests lock in the fix: the accounts table stays the single source of
 * truth, users.provider/subject are re-derived from it whenever Better Auth
 * creates an account (account.create.after hook) and after unlinking, and the
 * Profile page reads its connection state straight from accounts.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db');
  ctx.db = createTestDb();

  return (await import('../helpers/db-module')).mockDbModule(() => ctx.db);
});

// Stub better-auth so `betterAuth(options)` hands back the raw options object;
// the databaseHooks on getAuth().options are then the real functions Ingressi wired.
vi.mock('better-auth', () => ({
  betterAuth: (options: any) => ({ options }),
}));
vi.mock('better-auth/plugins', () => ({
  genericOAuth: () => ({}),
  username: () => ({}),
}));

import { getAuth } from '../../src/lib/auth-server';
import {
  createUser,
  getUserById,
  syncUserOAuthIdentity,
  listUserOAuthProviders,
} from '../../src/lib/models/user';
import { accounts, oauthProviders } from '../../src/lib/db/schema';
import { CREDENTIAL_ACCOUNT_ISSUER, resolveOAuthAccountIssuer } from '../../src/lib/account-issuer';
import { eq } from 'drizzle-orm';

// The unlink route imports `auth` and `checkSameOrigin` from @/src/lib/auth,
// which setup.vitest.ts mocks globally without checkSameOrigin. Re-mock with
// both, pointing the session at the user created inside the unlink test.
const unlinkTest = vi.hoisted(() => ({ userId: 0 }));
vi.mock('@/src/lib/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: String(unlinkTest.userId), email: 'unlink@example.com', role: 'user' } })),
  checkSameOrigin: vi.fn(() => null),
}));

const db = () => ctx.db;

const NOW = '2026-02-01T00:00:00.000Z';

async function seedProvider(id: string, issuer: string) {
  await db().insert(oauthProviders).values({
    id,
    name: `IdP ${id}`,
    type: 'oidc',
    clientId: 'cid',
    clientSecret: 'secret',
    issuer,
    scopes: 'openid email profile',
    autoLink: true,
    enabled: true,
    source: 'ui',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

/**
 * Mimic what Better Auth's internal adapter does on OAuth sign-up/link: a row
 * in `accounts`, nothing else. The account.create.after hook under test is the
 * seam Ingressi uses to keep users.provider/subject in step.
 */
async function createAccountLikeBetterAuth(userId: number, providerId: string, issuer: string, accountId: string) {
  await db().insert(accounts).values({
    userId,
    issuer: resolveOAuthAccountIssuer(providerId, issuer),
    accountId,
    providerId,
    createdAt: NOW,
    updatedAt: NOW,
  });

  const options = (getAuth() as any).options;
  expect(typeof options.databaseHooks?.account?.create?.after).toBe('function');
  await options.databaseHooks.account.create.after({
    userId: String(userId),
    providerId,
    issuer: resolveOAuthAccountIssuer(providerId, issuer),
    accountId,
  });
}

beforeAll(async () => {
  await seedProvider('prov-a', 'https://a.example');
  await seedProvider('prov-b', 'https://b.example');
});

describe('#261 — account.create.after keeps users.provider/subject in sync', () => {
  it('syncs provider/subject when Better Auth links an OAuth identity to an existing user', async () => {
    const user = await createUser({
      email: 'autolink@example.com',
      name: 'Auto Link',
      provider: 'credentials',
      subject: null as unknown as string,
      passwordHash: 'x'.repeat(60),
    });

    await createAccountLikeBetterAuth(user.id, 'prov-a', 'https://a.example', 'sub-a-1');

    const fresh = await getUserById(user.id);
    expect(fresh?.provider).toBe('prov-a');
    expect(fresh?.subject).toBe('sub-a-1');
  });

  it('syncs provider/subject for brand-new federated sign-ups too', async () => {
    // Better Auth creates the user first (provider/subject default to ""), then
    // the accounts row — the after-hook must still fix the columns.
    const user = await createUser({
      email: 'federated@example.com',
      name: 'Federated',
      provider: '',
      subject: '',
    });

    await createAccountLikeBetterAuth(user.id, 'prov-b', 'https://b.example', 'sub-b-1');

    const fresh = await getUserById(user.id);
    expect(fresh?.provider).toBe('prov-b');
    expect(fresh?.subject).toBe('sub-b-1');
  });

  it('also syncs on account updates (repeat OAuth sign-ins refresh the row)', async () => {
    const user = await createUser({
      email: 'resignin@example.com',
      name: 'Re Sign-in',
      provider: '',
      subject: '',
    });
    await db().insert(accounts).values({
      userId: user.id,
      issuer: resolveOAuthAccountIssuer('prov-a', 'https://a.example'),
      accountId: 'sub-a-resignin',
      providerId: 'prov-a',
      createdAt: NOW,
      updatedAt: NOW,
    });

    // Simulate a repeat sign-in: Better Auth updates the existing account row.
    const options = (getAuth() as any).options;
    await options.databaseHooks.account.update.after({
      userId: String(user.id),
      providerId: 'prov-a',
      issuer: resolveOAuthAccountIssuer('prov-a', 'https://a.example'),
      accountId: 'sub-a-resignin',
    });

    const fresh = await getUserById(user.id);
    expect(fresh?.provider).toBe('prov-a');
    expect(fresh?.subject).toBe('sub-a-resignin');
  });

  it('normalizes credential accounts to provider="credentials", subject=null', async () => {
    const user = await createUser({
      email: 'local@example.com',
      name: 'Local',
      provider: '',
      subject: '',
      passwordHash: 'y'.repeat(60),
    });
    await db().insert(accounts).values({
      userId: user.id,
      issuer: CREDENTIAL_ACCOUNT_ISSUER,
      accountId: String(user.id),
      providerId: 'credential',
      password: 'y'.repeat(60),
      createdAt: NOW,
      updatedAt: NOW,
    });

    const options = (getAuth() as any).options;
    await options.databaseHooks.account.create.after({
      userId: String(user.id),
      providerId: 'credential',
      issuer: CREDENTIAL_ACCOUNT_ISSUER,
      accountId: String(user.id),
    });

    const fresh = await getUserById(user.id);
    expect(fresh?.provider).toBe('credentials');
    expect(fresh?.subject).toBeNull();
  });
});

describe('#261 — syncUserOAuthIdentity', () => {
  it('prefers the latest OAuth account when several identities exist', async () => {
    const user = await createUser({
      email: 'multi@example.com',
      name: 'Multi',
      provider: 'credentials',
      subject: null as unknown as string,
      passwordHash: 'x'.repeat(60),
    });
    await db().insert(accounts).values([
      {
        userId: user.id,
        issuer: resolveOAuthAccountIssuer('prov-a', 'https://a.example'),
        accountId: 'sub-a-9',
        providerId: 'prov-a',
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        userId: user.id,
        issuer: resolveOAuthAccountIssuer('prov-b', 'https://b.example'),
        accountId: 'sub-b-9',
        providerId: 'prov-b',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);

    await syncUserOAuthIdentity(user.id);

    const fresh = await getUserById(user.id);
    expect(fresh?.provider).toBe('prov-b');
    expect(fresh?.subject).toBe('sub-b-9');
  });

  it('falls back to "credentials" once the OAuth identity is gone but a password remains', async () => {
    const user = await createUser({
      email: 'fallback@example.com',
      name: 'Fallback',
      provider: 'prov-a',
      subject: 'sub-a-fallback',
      passwordHash: 'x'.repeat(60),
    });
    await db().insert(accounts).values({
      userId: user.id,
      issuer: resolveOAuthAccountIssuer('prov-a', 'https://a.example'),
      accountId: 'sub-a-fallback',
      providerId: 'prov-a',
      createdAt: NOW,
      updatedAt: NOW,
    });

    // Simulate unlink: delete the OAuth account rows, then re-derive.
    await db().delete(accounts).where(eq(accounts.userId, user.id));
    await syncUserOAuthIdentity(user.id);

    const fresh = await getUserById(user.id);
    expect(fresh?.provider).toBe('credentials');
    expect(fresh?.subject).toBeNull();
  });

  it('clears provider for an identity-less user (no password, no OAuth)', async () => {
    const user = await createUser({
      email: 'bare@example.com',
      name: 'Bare',
      provider: 'prov-a',
      subject: 'sub-a-1',
    });
    await db().delete(accounts).where(eq(accounts.userId, user.id));

    await syncUserOAuthIdentity(user.id);

    const fresh = await getUserById(user.id);
    expect(fresh?.provider).toBeNull();
    expect(fresh?.subject).toBeNull();
  });
});

describe('#261 — unlink API re-derives identity from the accounts table', () => {
  it('resets users.provider/subject after the OAuth rows are deleted', async () => {
    const { POST } = await import('../../app/api/user/unlink-oauth/route');

    const user = await createUser({
      email: 'unlink@example.com',
      name: 'Unlink Me',
      provider: 'credentials',
      subject: null as unknown as string,
      passwordHash: 'x'.repeat(60),
    });
    unlinkTest.userId = user.id;
    await createAccountLikeBetterAuth(user.id, 'prov-a', 'https://a.example', 'sub-a-unlink');
    expect((await getUserById(user.id))?.provider).toBe('prov-a');

    const request = {
      method: 'POST',
      headers: {
        get: (name: string) => (name.toLowerCase() === 'origin' ? 'http://localhost:3000' : 'localhost:3000'),
      },
    } as unknown as Request;

    const response = await POST(request as any);
    expect(response.status).toBe(200);

    const fresh = await getUserById(user.id);
    expect(fresh?.provider).toBe('credentials');
    expect(fresh?.subject).toBeNull();

    const remaining = await db().select().from(accounts).where(eq(accounts.userId, user.id));
    expect(remaining.map((a) => a.providerId)).toEqual(['credential']);
  });
});

describe('#261 — profile connection state is derived from the accounts table', () => {
  it('lists linked OAuth providers from accounts, not from users.provider', async () => {
    const user = await createUser({
      email: 'derived@example.com',
      name: 'Derived',
      provider: '',
      subject: '',
      passwordHash: 'x'.repeat(60),
    });
    await createAccountLikeBetterAuth(user.id, 'prov-a', 'https://a.example', 'sub-a-derived');

    // Even if users.provider were stale, the profile must see the link.
    await db().update(
      (await import('../../src/lib/db/schema')).users,
    ).set({ provider: '', subject: '' }).where(eq((await import('../../src/lib/db/schema')).users.id, user.id));

    const linked = await listUserOAuthProviders(user.id);
    expect(linked).toEqual([{ providerId: 'prov-a', accountId: 'sub-a-derived' }]);

    // And after unlinking, the list empties.
    await db().delete(accounts).where(eq(accounts.userId, user.id));
    expect(await listUserOAuthProviders(user.id)).toEqual([]);
  });
});
