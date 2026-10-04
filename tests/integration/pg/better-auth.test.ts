/**
 * Better Auth on the application database (src/lib/db/auth-database.ts,
 * kysely-iso-dates.ts), on both dialects: what Better Auth stores is what
 * the rest of the schema stores (ISO 8601 text dates, real booleans), what
 * it reads back are Dates, its runtime schema validation passes (and still
 * catches a missing column), every query shape of its adapter works, and
 * the flows that depend on dates and transactions do: session refresh and
 * expiry, sign-out and sign-out everywhere, verification expiry, linking an
 * OAuth identity to an existing account through a generic OAuth provider
 * (a fake identity provider answers Better Auth's token and userinfo
 * requests), and the forward-auth portal signing in with the resulting
 * session.
 *
 * Boots the real db module and auth-server on the application database
 * (tests/helpers/app-database.ts): a SQLite file in the sqlite project, the
 * worker's PostgreSQL database in the postgres project. On SQLite it pins
 * the behaviour PostgreSQL has to match.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { APP_BASE_URL, AuthBrowser } from '../../helpers/mfa-browser';
import { openAppDatabase, type AppDatabase } from '../../helpers/app-database';

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));

// src/lib/auth.ts reads the request's headers through next/headers.
vi.mock('next/headers', () => ({
  headers: async () => requestHeaders.current,
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}));

const PASSWORD = 'Contract-Password-2026!';
const ISO_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const IDP = 'https://idp.example.test';
const DAY_MS = 24 * 60 * 60 * 1000;
const dialect = process.env.TEST_DB_DIALECT === 'postgres' ? 'postgres' : 'sqlite';

let database: AppDatabase;

type App = {
  appDb: Awaited<typeof import('../../../src/lib/db')>['appDb'];
  schema: typeof import('../../../src/lib/db/schema');
  ops: typeof import('../../../src/lib/db/ops');
  authServer: typeof import('../../../src/lib/auth-server');
  userModel: typeof import('../../../src/lib/models/user');
  forwardAuth: typeof import('../../../src/lib/models/forward-auth');
  secret: typeof import('../../../src/lib/secret');
  issuers: typeof import('../../../src/lib/account-issuer');
  sessionLogin: typeof import('../../../app/api/forward-auth/session-login/route');
  betterAuth: typeof import('better-auth')['betterAuth'];
};
let app: App;

beforeAll(async () => {
  database = await openAppDatabase('ingressi-better-auth-');
  // Vitest leaks Vite's BASE_URL='/' into process.env, which better-auth rejects.
  process.env.BASE_URL = APP_BASE_URL;
  process.env.AUTH_RATE_LIMIT_ENABLED = 'false';
  process.env.AUTH_ALLOW_SELF_REGISTRATION = 'true';
  vi.resetModules();
  // The real session reader (tests/setup.vitest.ts replaces it with a fixed session).
  vi.doUnmock('@/src/lib/auth');

  const dbModule = await import('../../../src/lib/db');
  app = {
    appDb: dbModule.appDb,
    schema: await import('../../../src/lib/db/schema'),
    ops: await import('../../../src/lib/db/ops'),
    authServer: await import('../../../src/lib/auth-server'),
    userModel: await import('../../../src/lib/models/user'),
    forwardAuth: await import('../../../src/lib/models/forward-auth'),
    secret: await import('../../../src/lib/secret'),
    issuers: await import('../../../src/lib/account-issuer'),
    sessionLogin: await import('../../../app/api/forward-auth/session-login/route'),
    betterAuth: (await import('better-auth')).betterAuth,
  };
});

afterAll(async () => {
  await database.close();
  delete process.env.AUTH_RATE_LIMIT_ENABLED;
  delete process.env.AUTH_ALLOW_SELF_REGISTRATION;
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Auth = any;
const auth = (): Auth => app.authServer.getAuth();
const context = async (): Promise<any> => await auth().$context;
const browser = () => new AuthBrowser(() => auth().handler);

let accountCounter = 0;

async function createAccount(email?: string): Promise<{ id: number; username: string; email: string }> {
  accountCounter += 1;
  const username = `contract-user-${accountCounter}`;
  const address = email ?? `${username}@example.com`;
  const user = await app.userModel.createUser({
    email: address,
    username,
    role: 'user',
    provider: 'credentials',
    subject: username,
    passwordHash: bcrypt.hashSync(PASSWORD, 4),
  });
  return { id: user.id, username, email: address };
}

async function signedIn(username: string): Promise<AuthBrowser> {
  const b = browser();
  const res = await b.post('/sign-in/username', { username, password: PASSWORD });
  expect(res.status).toBe(200);
  return b;
}

function sessionsOf(userId: number) {
  const { appDb, schema } = app;
  return appDb.select().from(schema.sessions).where(eq(schema.sessions.userId, userId)).orderBy(schema.sessions.id);
}

async function verificationRow(identifier: string) {
  const { appDb, schema, ops } = app;
  return await ops.first(appDb.select().from(schema.verifications).where(eq(schema.verifications.identifier, identifier)));
}

describe('Better Auth on the application database', () => {
  it(`gets a ${dialect} database and validates its schema at run time`, async () => {
    expect(auth().options.database).toMatchObject({ type: dialect, transaction: true });
    const ctx = await context();
    // Runtime validation is on (advanced.database.validateSchema is not false) and passes.
    expect(ctx.options.advanced?.database?.validateSchema).not.toBe(false);
    expect(ctx.checkSchema).toBeTypeOf('function');
    await expect(Promise.resolve(ctx.checkSchema())).resolves.toBeUndefined();
  });

  it('reports a column Better Auth needs and the database lacks', async () => {
    const options = auth().options;
    const strict = app.betterAuth({
      ...options,
      user: {
        ...options.user,
        additionalFields: { ...options.user.additionalFields, nickname: { type: 'string', required: false } },
      },
    });
    await expect(strict.api.getSession({ headers: new Headers() })).rejects.toThrow(/nickname/);
  });
});

describe('what Better Auth stores', () => {
  it('stores dates as ISO 8601 text and booleans as booleans, and returns Dates', async () => {
    const { appDb, schema, ops, issuers } = app;
    const before = Date.now();
    const result = await auth().api.signUpEmail({
      body: { email: 'stored@example.com', password: PASSWORD, name: 'Stored' },
    });
    expect(result.user.createdAt).toBeInstanceOf(Date);
    expect(result.user.emailVerified).toBe(false);

    const user = await ops.first(appDb.select().from(schema.users).where(eq(schema.users.email, 'stored@example.com')));
    expect(user).toBeDefined();
    expect(user!.createdAt).toMatch(ISO_TEXT);
    expect(user!.updatedAt).toMatch(ISO_TEXT);
    expect(user!.emailVerified).toBe(false);
    expect(user!.twoFactorEnabled).toBe(false);
    expect(Date.parse(user!.createdAt)).toBeGreaterThanOrEqual(before - 1000);

    const [session] = await sessionsOf(user!.id);
    expect(session.expiresAt).toMatch(ISO_TEXT);
    expect(Date.parse(session.expiresAt) - Date.now()).toBeGreaterThan(6 * DAY_MS);

    const account = await ops.first(appDb.select().from(schema.accounts).where(and(
      eq(schema.accounts.userId, user!.id),
      eq(schema.accounts.providerId, 'credential')
    )));
    expect(account!.createdAt).toMatch(ISO_TEXT);
    // The account.create.after hook (application code, joining Better Auth's transaction) ran.
    expect(account!.issuer).toBe(issuers.CREDENTIAL_ACCOUNT_ISSUER);

    // The new account signs in with its e-mail address and password.
    const b = browser();
    expect((await b.post('/sign-in/email', { email: 'stored@example.com', password: PASSWORD })).status).toBe(200);
    expect(JSON.parse((await b.get('/get-session')).body)).toMatchObject({ user: { email: 'stored@example.com' } });
    expect(await sessionsOf(user!.id)).toHaveLength(2);
  });

  it('answers every query shape of its adapter, with Dates', async () => {
    const { adapter } = await context();
    const now = Date.now();
    const past = new Date(now - 60_000);
    const soon = new Date(now + 60_000);
    const later = new Date(now + 120_000);
    const create = (identifier: string, expiresAt: Date) =>
      adapter.create({ model: 'verification', data: { identifier, value: identifier, expiresAt } });

    const a = await create('shape-a', past);
    const b = await create('shape-b', soon);
    const c = await create('shape-c', later);
    expect(a.expiresAt).toBeInstanceOf(Date);
    expect(a.expiresAt.getTime()).toBe(past.getTime());
    expect(a.createdAt).toBeInstanceOf(Date);
    expect((await verificationRow('shape-a'))!.expiresAt).toBe(past.toISOString());

    const found = await adapter.findOne({ model: 'verification', where: [{ field: 'identifier', value: 'shape-b' }] });
    expect(found.expiresAt).toEqual(soon);
    expect(found.id).toBe(b.id);

    const current = await adapter.findMany({
      model: 'verification',
      where: [{ field: 'expiresAt', operator: 'gt', value: new Date(now) }],
      sortBy: { field: 'expiresAt', direction: 'asc' },
      limit: 1,
      offset: 0,
    });
    expect(current.map((row: { identifier: string }) => row.identifier)).toEqual(['shape-b']);
    expect(current[0].expiresAt).toBeInstanceOf(Date);

    const insensitive = await adapter.findMany({
      model: 'verification',
      where: [{ field: 'identifier', operator: 'starts_with', value: 'SHAPE-', mode: 'insensitive' }],
      sortBy: { field: 'identifier', direction: 'desc' },
    });
    expect(insensitive.map((row: { identifier: string }) => row.identifier)).toEqual(['shape-c', 'shape-b', 'shape-a']);
    expect(await adapter.count({
      model: 'verification',
      where: [{ field: 'identifier', operator: 'in', value: ['shape-a', 'shape-b', 'shape-c'] }],
    })).toBe(3);

    const updated = await adapter.update({
      model: 'verification',
      where: [{ field: 'id', value: b.id }],
      update: { expiresAt: later },
    });
    expect(updated.expiresAt).toEqual(later);
    expect((await verificationRow('shape-b'))!.expiresAt).toBe(later.toISOString());
    expect(await adapter.updateMany({
      model: 'verification',
      where: [{ field: 'identifier', operator: 'in', value: ['shape-b', 'shape-c'] }],
      update: { value: 'changed' },
    })).toBe(2);

    const consumed = await adapter.consumeOne({ model: 'verification', where: [{ field: 'id', value: c.id }] });
    expect(consumed.expiresAt).toEqual(later);
    expect(await verificationRow('shape-c')).toBeUndefined();

    expect(await adapter.deleteMany({
      model: 'verification',
      where: [{ field: 'expiresAt', operator: 'lt', value: new Date(now) }],
    })).toBe(1);
    expect(await verificationRow('shape-a')).toBeUndefined();
    await adapter.delete({ model: 'verification', where: [{ field: 'id', value: b.id }] });
    expect(await verificationRow('shape-b')).toBeUndefined();
  });

  it('increments and locks with dates as the two-factor plugin does', async () => {
    const { adapter } = await context();
    const account = await createAccount();
    const row = await adapter.create({
      model: 'twoFactor',
      data: { userId: String(account.id), secret: 'not-a-real-secret', backupCodes: 'not-real-codes' },
    });
    expect(row.verified).toBe(true);
    const lockedUntil = new Date(Date.now() + 15 * 60_000);
    const locked = await adapter.incrementOne({
      model: 'twoFactor',
      where: [{ field: 'id', value: row.id }],
      increment: { failedVerificationCount: 1 },
      set: { lockedUntil },
    });
    expect(locked.failedVerificationCount).toBe(1);
    expect(locked.lockedUntil).toEqual(lockedUntil);
    const { appDb, schema, ops } = app;
    const stored = await ops.first(appDb.select().from(schema.twoFactors).where(eq(schema.twoFactors.userId, account.id)));
    expect(stored!.lockedUntil).toBe(lockedUntil.toISOString());

    // A lock that has not expired is not cleared (the plugin's own guard).
    expect(await adapter.incrementOne({
      model: 'twoFactor',
      where: [{ field: 'id', value: row.id }, { field: 'lockedUntil', operator: 'lte', value: new Date() }],
      increment: {},
      set: { failedVerificationCount: 0, lockedUntil: null },
    })).toBeNull();
  });
});

describe('sessions', () => {
  it('refreshes a session that is due and ends one that expired', async () => {
    const { appDb, schema } = app;
    const account = await createAccount();
    const b = await signedIn(account.username);
    const [session] = await sessionsOf(account.id);

    // Better Auth extends a session once a day (updateAge): make this one due.
    await appDb.update(schema.sessions)
      .set({ expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() })
      .where(eq(schema.sessions.id, session.id));
    const refreshed = await b.get('/get-session');
    expect(refreshed.status).toBe(200);
    expect(JSON.parse(refreshed.body)).toMatchObject({ user: { email: account.email } });
    const [after] = await sessionsOf(account.id);
    expect(after.expiresAt).toMatch(ISO_TEXT);
    expect(Date.parse(after.expiresAt) - Date.now()).toBeGreaterThan(6 * DAY_MS);

    await appDb.update(schema.sessions)
      .set({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(schema.sessions.id, session.id));
    const expired = await b.get('/get-session');
    expect(JSON.parse(expired.body ?? 'null')).toBeNull();
  });

  it('signs out one session, and every session of the account', async () => {
    const account = await createAccount();
    const first = await signedIn(account.username);
    const second = await signedIn(account.username);
    expect(await sessionsOf(account.id)).toHaveLength(2);

    expect((await first.post('/sign-out')).status).toBe(200);
    expect(await sessionsOf(account.id)).toHaveLength(1);
    expect(JSON.parse((await first.get('/get-session')).body ?? 'null')).toBeNull();
    expect(JSON.parse((await second.get('/get-session')).body ?? 'null')).toMatchObject({ user: { email: account.email } });

    await signedIn(account.username);
    expect(await sessionsOf(account.id)).toHaveLength(2);
    expect((await second.post('/revoke-sessions')).status).toBe(200);
    expect(await sessionsOf(account.id)).toHaveLength(0);
  });
});

describe('verifications', () => {
  it('treats an expired verification as gone and keeps current ones', async () => {
    const { internalAdapter } = await context();
    const now = Date.now();
    await internalAdapter.createVerificationValue({ identifier: 'expired-value', value: 'old', expiresAt: new Date(now - 60_000) });
    await internalAdapter.createVerificationValue({ identifier: 'current-value', value: 'new', expiresAt: new Date(now + 60_000) });

    // Reading one cleans up expired rows (a comparison of stored text with a Date).
    const current = await internalAdapter.findVerificationValue('current-value');
    expect(current).toMatchObject({ value: 'new' });
    expect(current.expiresAt).toBeInstanceOf(Date);
    expect(await verificationRow('expired-value')).toBeUndefined();

    await internalAdapter.createVerificationValue({ identifier: 'expired-once', value: 'x', expiresAt: new Date(now - 1000) });
    expect(await internalAdapter.consumeVerificationValue('expired-once')).toBeNull();
    expect(await verificationRow('expired-once')).toBeUndefined();
    expect(await internalAdapter.consumeVerificationValue('current-value')).toMatchObject({ value: 'new' });
    expect(await internalAdapter.consumeVerificationValue('current-value')).toBeNull();
  });
});

describe('linking an OAuth identity (generic OAuth)', () => {
  const profiles = new Map<string, Record<string, unknown>>();

  /** A fake identity provider: the token and userinfo endpoints Better Auth calls. */
  function fakeIdentityProvider() {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== IDP) return realFetch(input, init);
      if (url.pathname.endsWith('/token')) {
        const code = new URLSearchParams(await request.text()).get('code') ?? '';
        return Response.json({ access_token: `access-${code}`, refresh_token: `refresh-${code}`, token_type: 'Bearer', expires_in: 3600 });
      }
      if (url.pathname.endsWith('/userinfo')) {
        const token = request.headers.get('authorization')?.replace(/^Bearer access-/, '') ?? '';
        const profile = profiles.get(token);
        return profile ? Response.json(profile) : new Response('unknown token', { status: 401 });
      }
      return new Response('not found', { status: 404 });
    });
  }

  async function addProvider(id: string, autoLink: boolean) {
    const { appDb, schema, secret } = app;
    const now = new Date().toISOString();
    await appDb.insert(schema.oauthProviders).values({
      id,
      name: `Provider ${id}`,
      type: 'oidc',
      clientId: secret.encryptSecret(`client-${id}`),
      clientSecret: secret.encryptSecret(`secret-${id}`),
      issuer: `${IDP}/${id}`,
      authorizationUrl: `${IDP}/${id}/authorize`,
      tokenUrl: `${IDP}/${id}/token`,
      userinfoUrl: `${IDP}/${id}/userinfo`,
      scopes: 'openid email profile',
      autoLink,
      enabled: true,
      source: 'ui',
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Starts a sign-in through `providerId`; returns the browser and the state Better Auth stored. */
  async function startSignIn(providerId: string): Promise<{ b: AuthBrowser; state: string }> {
    const b = browser();
    const res = await b.post('/sign-in/social', { provider: providerId, callbackURL: '/' });
    expect(res.status).toBe(200);
    const state = new URL(res.body.url).searchParams.get('state');
    expect(state).toBeTruthy();
    return { b, state: state! };
  }

  async function callback(b: AuthBrowser, providerId: string, code: string, state: string) {
    const res = await b.get(`/callback/${providerId}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
    return { status: res.status, location: res.location ?? '' };
  }

  beforeAll(async () => {
    await addProvider('trusted-idp', true);
    await addProvider('manual-idp', false);
    await app.authServer.reloadOAuthProviders();
  });

  beforeEach(() => {
    fakeIdentityProvider();
  });

  it('links the identity of a trusted provider to the account with its email, and signs it in', async () => {
    const { appDb, schema, ops, secret } = app;
    const account = await createAccount('linked@example.com');
    profiles.set('linked-code', { sub: 'idp-subject-1', id: 'idp-subject-1', email: account.email, email_verified: true, name: 'Linked' });

    const { b, state } = await startSignIn('trusted-idp');
    const stored = await verificationRow(state);
    expect(stored!.expiresAt).toMatch(ISO_TEXT);
    expect(Date.parse(stored!.expiresAt)).toBeGreaterThan(Date.now());

    const res = await callback(b, 'trusted-idp', 'linked-code', state);
    expect(res.status).toBe(302);
    expect(res.location).not.toContain('error=');
    expect(b.has('session_token')).toBe(true);
    expect(await verificationRow(state)).toBeUndefined();

    const linked = await ops.first(appDb.select().from(schema.accounts).where(and(
      eq(schema.accounts.userId, account.id),
      eq(schema.accounts.providerId, 'trusted-idp')
    )));
    expect(linked).toMatchObject({ accountId: 'idp-subject-1', issuer: `${IDP}/trusted-idp` });
    expect(secret.isEncryptedSecret(linked!.accessToken!)).toBe(true);
    expect(linked!.accessTokenExpiresAt).toMatch(ISO_TEXT);
    const user = await ops.first(appDb.select().from(schema.users).where(eq(schema.users.id, account.id)));
    expect(user).toMatchObject({ provider: 'trusted-idp', subject: 'idp-subject-1' });

    const session = await b.get('/get-session');
    expect(JSON.parse(session.body)).toMatchObject({ user: { email: account.email } });

    // The forward-auth portal signs in with that dashboard session.
    const now = new Date().toISOString();
    const [host] = await appDb.insert(schema.proxyHosts).values({
      name: 'Portal app',
      domains: JSON.stringify(['app.example.com']),
      upstreams: JSON.stringify(['backend:8080']),
      sslForced: true,
      hstsEnabled: true,
      hstsSubdomains: false,
      allowWebsocket: true,
      preserveHostHeader: true,
      skipHttpsHostnameValidation: false,
      enabled: true,
      meta: JSON.stringify({ cpm_forward_auth: { enabled: true } }),
      createdAt: now,
      updatedAt: now,
    }).returning();
    await appDb.insert(schema.forwardAuthAccess).values({ proxyHostId: host.id, userId: account.id, groupId: null, createdAt: now });
    const rid = await app.forwardAuth.createRedirectIntent('https://app.example.com/');
    requestHeaders.current = new Headers({ cookie: b.cookieHeader(), origin: APP_BASE_URL });
    const portal = await app.sessionLogin.POST(new NextRequest(`${APP_BASE_URL}/api/forward-auth/session-login`, {
      method: 'POST',
      headers: { origin: APP_BASE_URL, 'content-type': 'application/json', cookie: b.cookieHeader() },
      body: JSON.stringify({ rid }),
    }));
    expect(portal.status).toBe(200);
    expect(new URL((await portal.json()).redirectTo).searchParams.get('code')).toBeTruthy();
  });

  it('refuses to link the identity of a provider that is not trusted', async () => {
    const { appDb, schema } = app;
    const account = await createAccount('unlinked@example.com');
    profiles.set('manual-code', { sub: 'idp-subject-2', id: 'idp-subject-2', email: account.email, email_verified: true, name: 'Manual' });

    const { b, state } = await startSignIn('manual-idp');
    const res = await callback(b, 'manual-idp', 'manual-code', state);
    expect(res.status).toBe(302);
    expect(res.location).toContain('error=account_not_linked');
    expect(b.has('session_token')).toBe(false);
    expect(await appDb.select().from(schema.accounts).where(eq(schema.accounts.providerId, 'manual-idp'))).toEqual([]);
    expect(await sessionsOf(account.id)).toHaveLength(0);
  });

  it('refuses a callback whose state was never stored', async () => {
    const { b } = await startSignIn('trusted-idp');
    const res = await callback(b, 'trusted-idp', 'linked-code', 'not-a-stored-state');
    expect(res.status).toBe(302);
    expect(res.location).toContain('error=');
    expect(b.has('session_token')).toBe(false);
  });
});
