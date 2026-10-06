/**
 * Better Auth's session.create.before hook (src/lib/auth-server.ts) decides,
 * after the password was checked, whether a sign-in gets a session at all.
 * Two of its checks became asynchronous:
 *
 *  - isSessionAllowedUnderSsoEnforcement (ee/sso): while SSO is enforced only
 *    identity-provider sign-ins and break-glass accounts get one;
 *  - isDirectorySessionAllowedUnderSsoEnforcement (ee/ldap): directory
 *    sign-in through a directory that stays open under enforcement.
 *
 * An un-awaited Promise is truthy, so a forgotten `await` either refuses
 * admits every sign-in (`!isAllowed(…) && …`). Each check is driven in both directions through the
 * real hook, against a real database, with the predicates unmocked.
 *
 * Like auth-oauth-role-injection.test.ts, better-auth is stubbed so that
 * getAuth().options is the configuration auth-server built, hooks included.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('@/src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('better-auth', () => ({
  betterAuth: (options: unknown) => ({ options }),
}));
vi.mock('better-auth/plugins', () => ({
  genericOAuth: () => ({}),
  username: () => ({}),
}));

import { getAuth } from '../../src/lib/auth-server';
import { logAuditEvent } from '../../src/lib/audit';
import { writeSsoEnforcement } from '../../ee/sso/enforcement-store';
import { isSessionAllowedUnderSsoEnforcement, isSsoEnforced } from '../../ee/sso/sign-in';
import { isDirectorySessionAllowedUnderSsoEnforcement, runDirectorySignIn } from '../../ee/ldap/sso';

const PROVIDER_USER = 10;
const DISABLED_USER = 12;
const BREAK_GLASS = 13;

const PASSWORD_SIGN_IN = '/sign-in/username';
const OAUTH_CALLBACK = '/callback/:id';
const LDAP_SIGN_IN = '/sign-in/ldap';

let openDirectory = 0;
let closedDirectory = 0;

const now = () => new Date().toISOString();

async function insertUser(id: number, status = 'active') {
  await ctx.db.insert(schema.users).values({
    id, email: `user${id}@example.com`, name: `User ${id}`, role: 'user', provider: 'credentials',
    subject: `user${id}@example.com`, status, createdAt: now(), updatedAt: now(),
  });
}

async function insertDirectory(name: string, allowWhenSsoEnforced: boolean): Promise<number> {
  const [row] = await ctx.db.insert(schema.ldapDirectories).values({
    name, enabled: true, allowWhenSsoEnforced, url: 'ldaps://ldap.example.com:636', bindDn: 'cn=reader,dc=example,dc=com',
    bindPassword: 'not-a-real-secret', userSearchBase: 'ou=people,dc=example,dc=com', userSearchFilter: '(uid={{username}})',
    createdAt: now(), updatedAt: now(),
  }).returning();
  return row.id;
}

type Outcome = { ok: true } | { ok: false; statusCode?: number; code?: string };

/** Runs the real session.create.before hook for `userId` on endpoint `path`. */
async function createSession(userId: number, path: string | undefined): Promise<Outcome> {
  const before = (getAuth() as any).options.databaseHooks.session.create.before;
  try {
    await before({ userId: String(userId) }, path === undefined ? null : { path });
    return { ok: true };
  } catch (error) {
    const e = error as { statusCode?: number; body?: { code?: string } };
    return { ok: false, statusCode: e.statusCode, code: e.body?.code };
  }
}

const REFUSED_BY_USERNAME = { ok: false, statusCode: 401, code: 'INVALID_USERNAME_OR_PASSWORD' };

beforeEach(async () => {
  ctx.db = createTestDb();
  vi.mocked(logAuditEvent).mockClear();
  await insertUser(PROVIDER_USER);
  await insertUser(DISABLED_USER, 'disabled');
  await insertUser(BREAK_GLASS);
  openDirectory = await insertDirectory('Open directory', true);
  closedDirectory = await insertDirectory('Closed directory', false);
});

describe('the hook is wired', () => {
  it('is a function on the configuration auth-server builds', () => {
    expect(typeof (getAuth() as any).options?.databaseHooks?.session?.create?.before).toBe('function');
  });
});

describe('enforced SSO in the session hook', () => {
  const enforce = (enabled: boolean) => writeSsoEnforcement(ctx.db, { enabled, breakGlassUserIds: [BREAK_GLASS] });

  it('returns real booleans', async () => {
    expect(await isSsoEnforced(ctx.db)).toBe(false);
    expect(await isSessionAllowedUnderSsoEnforcement(ctx.db, PROVIDER_USER, PASSWORD_SIGN_IN)).toBe(true);
    await enforce(true);
    expect(await isSsoEnforced(ctx.db)).toBe(true);
    expect(await isSessionAllowedUnderSsoEnforcement(ctx.db, PROVIDER_USER, PASSWORD_SIGN_IN)).toBe(false);
    expect(await isSessionAllowedUnderSsoEnforcement(ctx.db, BREAK_GLASS, PASSWORD_SIGN_IN)).toBe(true);
    expect(await isDirectorySessionAllowedUnderSsoEnforcement(ctx.db, PROVIDER_USER, PASSWORD_SIGN_IN)).toBe(false);
    expect(await isDirectorySessionAllowedUnderSsoEnforcement(ctx.db, PROVIDER_USER, LDAP_SIGN_IN)).toBe(false);
    expect(await runDirectorySignIn({ userId: PROVIDER_USER, directoryId: openDirectory }, () =>
      isDirectorySessionAllowedUnderSsoEnforcement(ctx.db, PROVIDER_USER, LDAP_SIGN_IN))).toBe(true);
    expect(await runDirectorySignIn({ userId: PROVIDER_USER, directoryId: closedDirectory }, () =>
      isDirectorySessionAllowedUnderSsoEnforcement(ctx.db, PROVIDER_USER, LDAP_SIGN_IN))).toBe(false);
  });

  it('leaves password sign-in alone while enforcement is off', async () => {
    await enforce(false);
    expect(await createSession(PROVIDER_USER, PASSWORD_SIGN_IN)).toEqual({ ok: true });
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  // Regression shape: `!isSessionAllowedUnderSsoEnforcement(…)` without await
  // is always false, so every password sign-in would get a session.
  it('refuses a password sign-in of an account that is not break-glass, and records it', async () => {
    await enforce(true);
    expect(await createSession(PROVIDER_USER, PASSWORD_SIGN_IN)).toEqual(REFUSED_BY_USERNAME);
    expect(await createSession(PROVIDER_USER, undefined)).toMatchObject({ ok: false, statusCode: 401 });
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      userId: PROVIDER_USER,
      action: 'sso_enforced_sign_in_refused',
    }));
  });

  it('admits a break-glass account and identity-provider sign-ins', async () => {
    await enforce(true);
    expect(await createSession(BREAK_GLASS, PASSWORD_SIGN_IN)).toEqual({ ok: true });
    expect(await createSession(PROVIDER_USER, OAUTH_CALLBACK)).toEqual({ ok: true });
  });

  // Regression shape: `!isDirectorySessionAllowedUnderSsoEnforcement(…)`
  // without await is always false, so a closed directory (or a password typed
  // on the directory endpoint for somebody else) would get a session.
  it('admits a directory sign-in only through a directory open under enforcement, for the user it signs in', async () => {
    await enforce(true);
    const viaDirectory = (directoryId: number, signedIn: number, sessionFor: number) =>
      runDirectorySignIn({ userId: signedIn, directoryId }, () => createSession(sessionFor, LDAP_SIGN_IN));

    expect(await viaDirectory(openDirectory, PROVIDER_USER, PROVIDER_USER)).toEqual({ ok: true });
    expect(await viaDirectory(closedDirectory, PROVIDER_USER, PROVIDER_USER)).toEqual(REFUSED_BY_USERNAME);
    expect(await viaDirectory(openDirectory, BREAK_GLASS, PROVIDER_USER)).toEqual(REFUSED_BY_USERNAME);
    expect(await createSession(PROVIDER_USER, LDAP_SIGN_IN)).toEqual(REFUSED_BY_USERNAME);
  });

  it('still refuses a disabled account on an open directory', async () => {
    await enforce(true);
    expect(await runDirectorySignIn({ userId: DISABLED_USER, directoryId: openDirectory }, () =>
      createSession(DISABLED_USER, LDAP_SIGN_IN))).toEqual(REFUSED_BY_USERNAME);
  });
});
