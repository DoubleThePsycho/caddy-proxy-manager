/**
 * mfaEnrolmentRequired (src/lib/mfa.ts) became asynchronous. Once an
 * account's MFA grace period is over and it has not enrolled, its dashboard
 * session can only reach /mfa-setup. Three call sites enforce that:
 *
 *  - proxy.ts (every protected page) redirects to /mfa-setup;
 *  - requireUser() in src/lib/auth.ts (pages and server actions) redirects;
 *  - authenticateApiRequest() in src/lib/api-auth.ts answers 403 to a
 *    session-authenticated REST call.
 *
 * tests/unit/mfa-gate-routing.test.ts and tests/unit/api-auth.test.ts mock
 * mfaEnrolmentRequired with a synchronous function, which hides a forgotten
 * `await`: an un-awaited Promise is truthy, so every account would be sent
 * to /mfa-setup (or refused with 403). Here the real predicate runs against a
 * real database, in both directions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb, sessionUserId: 0 }));

vi.mock('@/src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
// The real auth() and requireUser(), instead of the setup file's mock.
vi.mock('@/src/lib/auth', async (importOriginal) => importOriginal());
vi.mock('@/src/lib/auth-server', () => ({
  getAuth: () => ({
    api: {
      getSession: async () =>
        ctx.sessionUserId ? { user: { id: ctx.sessionUserId }, session: { id: 1, createdAt: new Date() } } : null,
    },
  }),
  reloadOAuthProviders: async () => {},
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

import middleware from '@/proxy';
import { requireUser } from '@/src/lib/auth';
import { ApiAuthError, authenticateApiRequest } from '@/src/lib/api-auth';
import { MFA_POLICY_SETTING_KEY, MFA_SETUP_PATH, mfaEnrolmentRequired } from '@/src/lib/mfa';

const ADMIN = 1;
const USER = 2;

async function seedUser(id: number, role: 'admin' | 'user') {
  const now = new Date().toISOString();
  const email = `user${id}@example.com`;
  await ctx.db.insert(schema.users).values({
    id, email, name: `User ${id}`, role, status: 'active', provider: 'credentials', subject: email,
    username: `user${id}`, createdAt: now, updatedAt: now,
  });
  // A password: the MFA policy only covers accounts that sign in with one.
  await ctx.db.insert(schema.accounts).values({
    userId: id, issuer: 'credential', accountId: String(id), providerId: 'credential',
    password: '$2a$04$hash', createdAt: now, updatedAt: now,
  });
}

/** "Require MFA for administrators", with the grace period already over. */
async function requireMfaForAdmins() {
  const value = JSON.stringify({ scope: 'admins', graceDays: 0, since: new Date(0).toISOString() });
  await ctx.db.insert(schema.settings).values({ key: MFA_POLICY_SETTING_KEY, value, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } });
}

async function turnPolicyOff() {
  await ctx.db.delete(schema.settings).where(eq(schema.settings.key, MFA_POLICY_SETTING_KEY));
}

function location(res: Response): string | null {
  const value = res.headers.get('location');
  return value ? new URL(value).pathname : null;
}

const page = (path: string) => middleware(new NextRequest(`http://localhost:3000${path}`));
const apiCall = () => authenticateApiRequest(new NextRequest('http://localhost:3000/api/v1/proxy-hosts'));

beforeEach(async () => {
  ctx.db = createTestDb();
  ctx.sessionUserId = 0;
  await seedUser(ADMIN, 'admin');
  await seedUser(USER, 'user');
  await requireMfaForAdmins();
});

describe('mfaEnrolmentRequired', () => {
  it('returns a real boolean', async () => {
    expect(await mfaEnrolmentRequired(ADMIN)).toBe(true);
    expect(await mfaEnrolmentRequired(USER)).toBe(false);
    await turnPolicyOff();
    expect(await mfaEnrolmentRequired(ADMIN)).toBe(false);
  });
});

describe('proxy.ts', () => {
  it('sends an account that must enrol to /mfa-setup, and lets it reach that page', async () => {
    ctx.sessionUserId = ADMIN;
    const res = await page('/proxy-hosts');
    expect(res.status).toBe(307);
    expect(location(res)).toBe(MFA_SETUP_PATH);
    expect(location(await page(MFA_SETUP_PATH))).toBeNull();
  });

  // Regression shape: `&& mfaEnrolmentRequired(…)` without await would send
  // these accounts to /mfa-setup as well.
  it('lets through an account the policy does not hold back', async () => {
    ctx.sessionUserId = USER;
    expect(location(await page('/proxy-hosts'))).toBeNull();
    await turnPolicyOff();
    ctx.sessionUserId = ADMIN;
    expect(location(await page('/proxy-hosts'))).toBeNull();
  });
});

describe('requireUser (src/lib/auth.ts)', () => {
  it('redirects an account that must enrol to /mfa-setup', async () => {
    ctx.sessionUserId = ADMIN;
    await expect(requireUser()).rejects.toThrow(`REDIRECT:${MFA_SETUP_PATH}`);
  });

  it('returns the session of an account the policy does not hold back', async () => {
    ctx.sessionUserId = USER;
    await expect(requireUser()).resolves.toMatchObject({ user: { id: String(USER) } });
    await turnPolicyOff();
    ctx.sessionUserId = ADMIN;
    await expect(requireUser()).resolves.toMatchObject({ user: { id: String(ADMIN) } });
  });
});

describe('authenticateApiRequest (src/lib/api-auth.ts)', () => {
  it('answers 403 to a session of an account that must enrol', async () => {
    ctx.sessionUserId = ADMIN;
    const error = await apiCall().then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ApiAuthError);
    expect(error).toMatchObject({ status: 403, message: 'Set up multi-factor authentication to continue' });
  });

  it('authenticates the session of an account the policy does not hold back', async () => {
    ctx.sessionUserId = USER;
    await expect(apiCall()).resolves.toMatchObject({ userId: USER, authMethod: 'session' });
    await turnPolicyOff();
    ctx.sessionUserId = ADMIN;
    await expect(apiCall()).resolves.toMatchObject({ userId: ADMIN, authMethod: 'session' });
  });
});
