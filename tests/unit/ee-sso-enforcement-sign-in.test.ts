/**
 * Enforced SSO (ee/sso) at sign-in: with enforcement on, every password
 * sign-in path of Better Auth (username and email, through auth.api and over
 * HTTP) refuses accounts that are not break-glass accounts exactly as it
 * refuses a wrong password, self-registration is closed, and sessions are
 * only created by SSO endpoints or for break-glass accounts. None of it
 * depends on the license: these tests run with no key and with an expired one.
 *
 * Like auth-sign-in-username.test.ts, this boots the real db module and the
 * real auth-server against the application database: a SQLite file, or in the
 * postgres project the worker's PostgreSQL database (tests/helpers/app-database.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { runWithEndpointContext } from '@better-auth/core/context';
import { createTestSigner, licensePayload, signLicense } from '../helpers/license';
import { openAppDatabase, type AppDatabase } from '../helpers/app-database';

let database: AppDatabase;

const APP_BASE_URL = 'http://localhost:3000';
const PASSWORD = 'Correct-Horse-9!';
const WRONG = 'Wrong-Horse-9!!';
const ENV_ADMIN_PASSWORD = 'Env-Admin-Password-2026!';

type App = {
  db: Awaited<typeof import('../../src/lib/db')>['default'];
  schema: typeof import('../../src/lib/db/schema');
  auth: ReturnType<Awaited<typeof import('../../src/lib/auth-server')>['getAuth']>;
  userModel: typeof import('../../src/lib/models/user');
  store: typeof import('../../ee/sso/enforcement-store');
  audit: typeof import('../../src/lib/audit');
  licenseStore: typeof import('../../ee/licensing/store');
  publicKeys: typeof import('../../ee/licensing/public-keys');
  ensureAdminUser: Awaited<typeof import('../../src/lib/init-db')>['ensureAdminUser'];
};
let app: App;
const ids = { breakGlass: 0, alice: 0, bob: 0, admin: 1 };

beforeAll(async () => {
  database = await openAppDatabase('ingressi-sso-enforce-');
  // Vitest leaks Vite's BASE_URL='/' into process.env, which better-auth rejects.
  process.env.BASE_URL = APP_BASE_URL;
  process.env.AUTH_RATE_LIMIT_ENABLED = 'false';
  process.env.AUTH_ALLOW_SELF_REGISTRATION = 'true';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = ENV_ADMIN_PASSWORD;
  vi.resetModules();

  const dbModule = await import('../../src/lib/db');
  const schema = await import('../../src/lib/db/schema');
  const { getAuth } = await import('../../src/lib/auth-server');
  const userModel = await import('../../src/lib/models/user');
  const store = await import('../../ee/sso/enforcement-store');
  const audit = await import('../../src/lib/audit');
  const licenseStore = await import('../../ee/licensing/store');
  const publicKeys = await import('../../ee/licensing/public-keys');
  const { ensureAdminUser } = await import('../../src/lib/init-db');
  app = {
    db: dbModule.default, schema, auth: getAuth(), userModel, store, audit, licenseStore, publicKeys, ensureAdminUser,
  };

  await ensureAdminUser();
  const hash = bcrypt.hashSync(PASSWORD, 4);
  const create = (email: string, username: string, role: 'admin' | 'user') =>
    userModel.createUser({ email, username, role, provider: 'credentials', subject: email, passwordHash: hash });
  ids.breakGlass = (await create('breakglass@example.com', 'breakglass', 'admin')).id;
  ids.alice = (await create('alice@example.com', 'alice', 'admin')).id;
  ids.bob = (await create('bob@example.com', 'bob', 'user')).id;
});

afterAll(async () => {
  app.publicKeys.setTrustedLicenseKeysForTests(null);
  await database.close();
  for (const key of ['AUTH_RATE_LIMIT_ENABLED', 'AUTH_ALLOW_SELF_REGISTRATION', 'ADMIN_USERNAME', 'ADMIN_PASSWORD']) {
    delete process.env[key];
  }
  vi.resetModules();
});

async function enforce(enabled: boolean, breakGlassUserIds: number[] = [ids.breakGlass]) {
  await app.store.writeSsoEnforcement(app.db, { enabled, breakGlassUserIds });
}

async function setStatus(userId: number, status: string) {
  const { eq } = await import('drizzle-orm');
  await app.db.update(app.schema.users).set({ status }).where(eq(app.schema.users.id, userId));
}

beforeEach(async () => {
  await enforce(false);
  await app.licenseStore.removeLicenseKey();
  await setStatus(ids.breakGlass, 'active');
  vi.mocked(app.audit.logAuditEvent).mockClear();
});

type ApiCall = (args: { body: Record<string, unknown> }) => Promise<unknown>;
const api = (name: string) => (app.auth.api as unknown as Record<string, ApiCall>)[name];

type Outcome = { ok: true; userId: string | undefined } | { ok: false; statusCode?: number; message?: string; code?: string };

async function attempt(call: Promise<unknown>): Promise<Outcome> {
  try {
    const result = (await call) as { user?: { id?: string } };
    return { ok: true, userId: result.user?.id };
  } catch (e) {
    const error = e as { statusCode?: number; message?: string; body?: { message?: string; code?: string } };
    return { ok: false, statusCode: error.statusCode, message: error.body?.message ?? error.message, code: error.body?.code };
  }
}

const byUsername = (username: string, password: string) =>
  attempt(api('signInUsername')({ body: { username, password } }));
const byEmail = (email: string, password: string) =>
  attempt(api('signInEmail')({ body: { email, password } }));

async function http(path: string, body: Record<string, unknown>) {
  const res = await app.auth.handler(new Request(`${APP_BASE_URL}/api/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: APP_BASE_URL },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json().catch(() => null), setCookie: res.headers.get('set-cookie') };
}

async function sessionCount(userId: number): Promise<number> {
  const { db, schema } = app;
  const { eq } = await import('drizzle-orm');
  return (await db.select().from(schema.sessions).where(eq(schema.sessions.userId, userId))).length;
}

describe('enforced SSO: password sign-in', () => {
  it('leaves password sign-in alone while enforcement is off', async () => {
    expect(await byUsername('alice', PASSWORD)).toEqual({ ok: true, userId: String(ids.alice) });
    expect(await byEmail('alice@example.com', PASSWORD)).toEqual({ ok: true, userId: String(ids.alice) });
  });

  it('refuses a correct password by username exactly as a wrong one', async () => {
    await enforce(true);
    const before = await sessionCount(ids.alice);
    const correct = await byUsername('alice', PASSWORD);
    const wrong = await byUsername('alice', WRONG);
    expect(correct).toEqual({ ok: false, statusCode: 401, message: 'Invalid username or password', code: 'INVALID_USERNAME_OR_PASSWORD' });
    expect(correct).toEqual(wrong);
    expect(await sessionCount(ids.alice)).toBe(before);
  });

  it('refuses a correct password by email exactly as a wrong one', async () => {
    await enforce(true);
    const correct = await byEmail('alice@example.com', PASSWORD);
    expect(correct).toEqual({ ok: false, statusCode: 401, message: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD' });
    expect(correct).toEqual(await byEmail('alice@example.com', WRONG));
    expect(correct).toEqual(await byEmail('nobody@example.com', WRONG));
  });

  it('refuses over HTTP with the same response as a wrong password and sets no session cookie', async () => {
    await enforce(true);
    for (const [path, body, wrongBody] of [
      ['/sign-in/username', { username: 'bob', password: PASSWORD }, { username: 'bob', password: WRONG }],
      ['/sign-in/email', { email: 'bob@example.com', password: PASSWORD }, { email: 'bob@example.com', password: WRONG }],
    ] as const) {
      const correct = await http(path, body);
      const wrong = await http(path, wrongBody);
      expect(correct.status).toBe(401);
      expect(correct.body).toEqual(wrong.body);
      expect(correct.setCookie ?? '').not.toMatch(/session_token=[^;]/);
    }
  });

  it('signs in a break-glass account by username and by email, through auth.api and over HTTP', async () => {
    await enforce(true);
    expect(await byUsername('breakglass', PASSWORD)).toEqual({ ok: true, userId: String(ids.breakGlass) });
    expect(await byEmail('breakglass@example.com', PASSWORD)).toEqual({ ok: true, userId: String(ids.breakGlass) });
    const res = await http('/sign-in/username', { username: 'BreakGlass', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.setCookie).toMatch(/session_token=[^;]/);
  });

  it('still checks the password and the status of a break-glass account', async () => {
    await enforce(true);
    expect(await byUsername('breakglass', WRONG)).toMatchObject({ ok: false, statusCode: 401 });
    // Directly in the database: the lockout guard refuses disabling the last break-glass admin.
    await setStatus(ids.breakGlass, 'disabled');
    expect(await byUsername('breakglass', PASSWORD)).toMatchObject({ ok: false, statusCode: 401 });
  });

  it('records a refused correct password in the audit log', async () => {
    await enforce(true);
    await byUsername('alice', PASSWORD);
    expect(app.audit.logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      userId: ids.alice,
      action: 'sso_enforced_sign_in_refused',
    }));
  });

  it('keeps enforcing with no license and with an expired license', async () => {
    await enforce(true);
    expect((await app.licenseStore.getLicenseState()).status).toBe('unlicensed');
    expect(await byUsername('alice', PASSWORD)).toMatchObject({ ok: false, statusCode: 401 });

    const signer = createTestSigner();
    app.publicKeys.setTrustedLicenseKeysForTests(signer.keys);
    const { setSetting } = await import('../../src/lib/settings');
    await setSetting(app.licenseStore.LICENSE_SETTING_KEY, signLicense(signer, licensePayload(signer, {
      iat: '2020-01-01T00:00:00.000Z', exp: '2021-01-01T00:00:00.000Z',
    })));
    expect((await app.licenseStore.getLicenseState()).status).toBe('expired');
    expect(await byUsername('alice', PASSWORD)).toMatchObject({ ok: false, statusCode: 401 });
    expect(await byUsername('breakglass', PASSWORD)).toEqual({ ok: true, userId: String(ids.breakGlass) });
  });
});

describe('enforced SSO: the primary admin and ADMIN_PASSWORD', () => {
  it('does not let the environment password bypass enforcement', async () => {
    expect(await byUsername('admin', ENV_ADMIN_PASSWORD)).toEqual({ ok: true, userId: '1' });
    await enforce(true);
    // Re-applying the environment credentials (the documented reset) changes nothing.
    await app.ensureAdminUser();
    expect(await byUsername('admin', ENV_ADMIN_PASSWORD)).toMatchObject({ ok: false, statusCode: 401 });
  });

  it('lets the primary admin in when it is a break-glass account', async () => {
    await enforce(true, [ids.admin]);
    expect(await byUsername('admin', ENV_ADMIN_PASSWORD)).toEqual({ ok: true, userId: '1' });
  });
});

describe('enforced SSO: self-registration', () => {
  const signUp = (email: string) => attempt(api('signUpEmail')({
    body: { email, password: 'Strong-Password-2026!', name: email.split('@')[0] },
  }));

  it('refuses it before the account is created, through auth.api and over HTTP', async () => {
    await enforce(true);
    expect(await signUp('newcomer@example.com')).toEqual({
      ok: false, statusCode: 400, message: 'Email and password sign up is not enabled', code: 'EMAIL_PASSWORD_SIGN_UP_DISABLED',
    });
    const res = await http('/sign-up/email', { email: 'newcomer2@example.com', password: 'Strong-Password-2026!', name: 'n' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EMAIL_PASSWORD_SIGN_UP_DISABLED' });
    expect(await app.userModel.findUserByEmail('newcomer@example.com')).toBeNull();
    expect(await app.userModel.findUserByEmail('newcomer2@example.com')).toBeNull();
  });

  it('works again once enforcement is off', async () => {
    expect(await signUp('later@example.com')).toMatchObject({ ok: true });
  });
});

describe('enforced SSO: sessions by endpoint', () => {
  async function createSession(userId: number, path?: string) {
    const ctx = await (app.auth as unknown as { $context: Promise<{ internalAdapter: { createSession: (id: string) => Promise<unknown> } }> }).$context;
    const run = () => ctx.internalAdapter.createSession(String(userId));
    return attempt(path === undefined ? run() : runWithEndpointContext({ path, context: ctx } as never, run));
  }

  it('lets the OAuth callback and social sign-in create sessions for any account', async () => {
    await enforce(true);
    expect(await createSession(ids.alice, '/callback/:id')).toMatchObject({ ok: true });
    expect(await createSession(ids.bob, '/sign-in/social')).toMatchObject({ ok: true });
  });

  it('refuses sessions from any other endpoint, or from no endpoint, unless the account is break-glass', async () => {
    await enforce(true);
    expect(await createSession(ids.alice)).toMatchObject({ ok: false, statusCode: 401 });
    expect(await createSession(ids.alice, '/verify-email')).toMatchObject({ ok: false, statusCode: 401 });
    expect(await createSession(ids.alice, '/sign-up/email')).toMatchObject({ ok: false, statusCode: 401 });
    expect(await createSession(ids.breakGlass, '/verify-email')).toMatchObject({ ok: true });
    expect(await createSession(ids.breakGlass)).toMatchObject({ ok: true });
  });
});
