/**
 * The forward-auth portal reuses a dashboard session only when an identity
 * provider created it (OIDC, SAML or LDAP sign-in): single sign-on across
 * apps then comes from the customer's provider, and Ingressi stays a relying
 * party. Password and passkey sessions, and sessions from before the sign-in
 * method was recorded, are not reused: those users sign in at the portal.
 *
 * Boots the real db module and auth-server (like auth-mfa.test.ts) and drives
 * Better Auth over its HTTP handler: the session hook records the method, an
 * MFA rotation keeps it, and the session-login route and the portal's check
 * (portalMayReuseSession) honour it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { NextRequest } from 'next/server';
import { APP_BASE_URL, AuthBrowser, totpCode, totpSecretFromUri } from '../helpers/mfa-browser';
import { openAppDatabase, type AppDatabase } from '../helpers/app-database';
import { runWithEndpointContext } from '@better-auth/core/context';

const headerState = vi.hoisted(() => ({ cookie: '' }));

// tests/setup.vitest.ts replaces the auth module with a stub; this file needs the real one.
vi.unmock('@/src/lib/auth');

// The session-login route reads the request's cookies through next/headers.
vi.mock('next/headers', () => ({
  headers: async () => new Headers(headerState.cookie ? { cookie: headerState.cookie } : {}),
}));

let database: AppDatabase;
const PASSWORD = 'Correct-Horse-9!';
const SESSION_COOKIE = 'better-auth.session_token';

type App = {
  db: Awaited<typeof import('../../src/lib/db')>['default'];
  schema: typeof import('../../src/lib/db/schema');
  auth: ReturnType<Awaited<typeof import('../../src/lib/auth-server')>['getAuth']>;
  userModel: typeof import('../../src/lib/models/user');
  sessions: typeof import('../../src/lib/models/sessions');
  authLib: typeof import('../../src/lib/auth');
  sessionLogin: typeof import('../../app/api/forward-auth/session-login/route');
  saml: typeof import('../../ee/saml/constants');
  ldap: typeof import('../../ee/ldap/constants');
};
let app: App;

beforeAll(async () => {
  database = await openAppDatabase('ingressi-portal-reuse-');
  process.env.BASE_URL = APP_BASE_URL;
  process.env.AUTH_RATE_LIMIT_ENABLED = 'false';
  vi.resetModules();
  const dbModule = await import('../../src/lib/db');
  const { getAuth } = await import('../../src/lib/auth-server');
  app = {
    db: dbModule.default,
    schema: await import('../../src/lib/db/schema'),
    auth: getAuth(),
    userModel: await import('../../src/lib/models/user'),
    sessions: await import('../../src/lib/models/sessions'),
    authLib: await import('../../src/lib/auth'),
    sessionLogin: await import('../../app/api/forward-auth/session-login/route'),
    saml: await import('../../ee/saml/constants'),
    ldap: await import('../../ee/ldap/constants'),
  };
});

afterAll(async () => {
  await database.close();
  delete process.env.AUTH_RATE_LIMIT_ENABLED;
  vi.resetModules();
});

let counter = 0;

async function createAccount(): Promise<{ id: number; username: string }> {
  counter += 1;
  const username = `reuse-user-${counter}`;
  const user = await app.userModel.createUser({
    email: `${username}@example.com`,
    username,
    role: 'user',
    provider: 'credentials',
    subject: username,
    passwordHash: bcrypt.hashSync(PASSWORD, 4),
  });
  return { id: user.id, username };
}

const browser = () => new AuthBrowser(() => app.auth.handler);

async function signedIn(username: string): Promise<AuthBrowser> {
  const b = browser();
  const res = await b.post('/sign-in/username', { username, password: PASSWORD });
  expect(res.status).toBe(200);
  expect(b.has('session_token')).toBe(true);
  return b;
}

async function sessionMethods(userId: number): Promise<Array<string | null>> {
  const { eq } = await import('drizzle-orm');
  const rows = await app.db
    .select({ signInMethod: app.schema.sessions.signInMethod })
    .from(app.schema.sessions)
    .where(eq(app.schema.sessions.userId, userId));
  return rows.map((row) => row.signInMethod);
}

/** A session row written straight to the database, and the signed cookie that names it. */
async function sessionWith(userId: number, signInMethod: string | null): Promise<{ id: number; cookie: string }> {
  counter += 1;
  const token = `reuse-token-${counter}-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  const [row] = await app.db.insert(app.schema.sessions).values({
    userId,
    token,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    createdAt: now,
    updatedAt: now,
    signInMethod,
  }).returning();
  const { makeSignature } = await import('better-auth/crypto');
  const signed = encodeURIComponent(`${token}.${await makeSignature(token, process.env.SESSION_SECRET!)}`);
  return { id: row.id, cookie: `${SESSION_COOKIE}=${signed}` };
}

/** Runs the real session.create.after hook for an existing session row. */
async function completeSignIn(sessionId: number, userId: number, context: Record<string, unknown>) {
  const after = (app.auth as unknown as { options: { databaseHooks: { session: { create: { after: (session: unknown, context: unknown) => Promise<void> } } } } })
    .options.databaseHooks.session.create.after;
  await after({ id: String(sessionId), userId: String(userId) }, context);
}

async function methodOf(sessionId: number): Promise<string | null> {
  return await app.sessions.getSessionSignInMethod(sessionId);
}

describe('which sign-in methods the portal reuses', () => {
  it.each([
    ['sso', true],
    ['saml', true],
    ['ldap', true],
    ['password', false],
    ['passkey', false],
    [null, false],
    ['', false],
    ['other', false],
  ])('%s → %s', (method, reusable) => {
    expect(app.sessions.isPortalReusableSignInMethod(method)).toBe(reusable);
  });
});

describe('the session records how it was signed in to', () => {
  it('a password sign-in', async () => {
    const account = await createAccount();
    await signedIn(account.username);
    expect(await sessionMethods(account.id)).toEqual(['password']);
  });

  it('an MFA enrolment rotates the session and keeps the method', async () => {
    const account = await createAccount();
    const b = await signedIn(account.username);
    const enable = await b.post('/two-factor/enable', { password: PASSWORD });
    expect(enable.status).toBe(200);
    const verify = await b.post('/two-factor/verify-totp', { code: await totpCode(totpSecretFromUri(enable.body.totpURI)) });
    expect(verify.status).toBe(200);
    const afterEnrolment = await sessionMethods(account.id);
    expect(afterEnrolment.length).toBeGreaterThan(0);
    expect(afterEnrolment.every((method) => method === 'password')).toBe(true);

    // The second step of a later sign-in completes the password sign-in it started.
    const challenge = browser();
    const first = await challenge.post('/sign-in/username', { username: account.username, password: PASSWORD });
    expect(first.body).toMatchObject({ twoFactorRedirect: true });
    const second = await challenge.post('/two-factor/verify-totp', {
      code: await totpCode(totpSecretFromUri(enable.body.totpURI), 1),
    });
    expect(second.status).toBe(200);
    expect((await sessionMethods(account.id)).every((method) => method === 'password')).toBe(true);
  });

  it('an OIDC sign-in records sso, and an MFA rotation of that session keeps it', async () => {
    const account = await createAccount();
    // A session created the way the OIDC callback creates one runs the real session hooks.
    const authCtx = await (app.auth as unknown as {
      $context: Promise<{ internalAdapter: { createSession: (id: string) => Promise<{ id: string | number; token: string }> } }>;
    }).$context;
    const oidcSession = await runWithEndpointContext(
      { path: '/callback/:id', params: { id: 'dex' }, context: authCtx } as never,
      () => authCtx.internalAdapter.createSession(String(account.id)),
    );
    expect(await methodOf(Number(oidcSession.id))).toBe('sso');

    const { makeSignature } = await import('better-auth/crypto');
    const b = browser();
    b.cookies.set(SESSION_COOKIE, encodeURIComponent(`${oidcSession.token}.${await makeSignature(oidcSession.token, process.env.SESSION_SECRET!)}`));
    const enable = await b.post('/two-factor/enable', { password: PASSWORD });
    expect(enable.status).toBe(200);
    const verify = await b.post('/two-factor/verify-totp', { code: await totpCode(totpSecretFromUri(enable.body.totpURI)) });
    expect(verify.status).toBe(200);

    const { and, eq, ne } = await import('drizzle-orm');
    const replacements = await app.db
      .select({ signInMethod: app.schema.sessions.signInMethod })
      .from(app.schema.sessions)
      .where(and(eq(app.schema.sessions.userId, account.id), ne(app.schema.sessions.id, Number(oidcSession.id))));
    expect(replacements.length).toBeGreaterThan(0);
    expect(replacements.every((row) => row.signInMethod === 'sso')).toBe(true);
  });

  it.each([
    ['OIDC', () => ({ path: '/callback/:id', params: { id: 'dex' } }), 'sso'],
    ['SAML', () => ({ path: app.saml.SAML_ACS_PATH, params: { providerId: '1' } }), 'saml'],
    ['LDAP', () => ({ path: app.ldap.LDAP_SIGN_IN_PATH, body: { directoryId: 1 } }), 'ldap'],
    ['a passkey', () => ({ path: '/passkey/verify-authentication' }), 'passkey'],
  ])('%s', async (_name, context, expected) => {
    const account = await createAccount();
    const { id } = await sessionWith(account.id, null);
    await completeSignIn(id, account.id, context());
    expect(await methodOf(id)).toBe(expected);
  });
});

describe('the portal reuses only identity-provider sessions', () => {
  const request = (cookie: string) =>
    new NextRequest(`${APP_BASE_URL}/portal`, { headers: { cookie } });

  it.each([
    ['sso', true],
    ['saml', true],
    ['ldap', true],
    ['password', false],
    ['passkey', false],
    [null, false],
  ])('portalMayReuseSession for a %s session → %s', async (method, expected) => {
    const account = await createAccount();
    const { cookie } = await sessionWith(account.id, method);
    expect(await app.authLib.portalMayReuseSession(request(cookie))).toBe(expected);
  });

  it('is false without a session', async () => {
    expect(await app.authLib.portalMayReuseSession(request(''))).toBe(false);
  });

  async function postSessionLogin(cookie: string, body: Record<string, unknown> = {}) {
    headerState.cookie = cookie;
    try {
      const res = await app.sessionLogin.POST(new NextRequest(`${APP_BASE_URL}/api/forward-auth/session-login`, {
        method: 'POST',
        headers: { origin: APP_BASE_URL, 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      }));
      return { status: res.status, body: await res.json() };
    } finally {
      headerState.cookie = '';
    }
  }

  it.each(['password', 'passkey', null])('the session-login route refuses a %s session', async (method) => {
    const account = await createAccount();
    const { cookie } = await sessionWith(account.id, method);
    expect(await postSessionLogin(cookie, { rid: 'x'.repeat(32) })).toEqual({ status: 401, body: { error: 'Sign in to continue.' } });
  });

  it.each(['sso', 'saml', 'ldap'])('the session-login route accepts a %s session (then checks the redirect intent)', async (method) => {
    const account = await createAccount();
    const { cookie } = await sessionWith(account.id, method);
    // Past the session check, a request without a redirect intent fails on that instead.
    expect(await postSessionLogin(cookie)).toEqual({ status: 400, body: { error: 'Missing redirect intent' } });
  });

  it('a real password sign-in is not reused', async () => {
    const account = await createAccount();
    const b = await signedIn(account.username);
    expect(await app.authLib.portalMayReuseSession(request(b.cookieHeader()))).toBe(false);
    expect((await postSessionLogin(b.cookieHeader(), { rid: 'x'.repeat(32) })).status).toBe(401);
  });
});
