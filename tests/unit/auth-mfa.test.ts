/**
 * Dashboard MFA (Better Auth's two-factor plugin as Ingressi configures it), end to
 * end over Better Auth's HTTP handler: enrolment, the second sign-in step with
 * TOTP and backup codes, wrong, expired and replayed codes, attempt limits,
 * what is stored and what is never returned, turning MFA off, and the
 * interaction with account status and enforced SSO (break-glass accounts).
 *
 * Like ee-sso-enforcement-sign-in.test.ts, this boots the real db module and
 * the real auth-server against the application database: a SQLite file, or in the
 * postgres project the worker's PostgreSQL database (tests/helpers/app-database.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { runWithEndpointContext } from '@better-auth/core/context';
import { APP_BASE_URL, AuthBrowser, totpCode, totpSecretFromUri } from '../helpers/mfa-browser';
import { first as dbFirst } from '@/src/lib/db/ops';
import { openAppDatabase, type AppDatabase } from '../helpers/app-database';

let database: AppDatabase;

const PASSWORD = 'Correct-Horse-9!';
const WRONG = 'Wrong-Horse-9!!';

type App = {
  db: Awaited<typeof import('../../src/lib/db')>['default'];
  schema: typeof import('../../src/lib/db/schema');
  auth: ReturnType<Awaited<typeof import('../../src/lib/auth-server')>['getAuth']>;
  userModel: typeof import('../../src/lib/models/user');
  mfa: typeof import('../../src/lib/mfa');
  mfaAuth: typeof import('../../src/lib/mfa-auth');
  ssoStore: typeof import('../../ee/sso/enforcement-store');
  audit: typeof import('../../src/lib/audit');
  secret: typeof import('../../src/lib/secret');
};
let app: App;

beforeAll(async () => {
  database = await openAppDatabase('ingressi-mfa-');
  // Vitest leaks Vite's BASE_URL='/' into process.env, which better-auth rejects.
  process.env.BASE_URL = APP_BASE_URL;
  process.env.AUTH_RATE_LIMIT_ENABLED = 'false';
  vi.resetModules();

  const dbModule = await import('../../src/lib/db');
  const schema = await import('../../src/lib/db/schema');
  const { getAuth } = await import('../../src/lib/auth-server');
  app = {
    db: dbModule.default,
    schema,
    auth: getAuth(),
    userModel: await import('../../src/lib/models/user'),
    mfa: await import('../../src/lib/mfa'),
    mfaAuth: await import('../../src/lib/mfa-auth'),
    ssoStore: await import('../../ee/sso/enforcement-store'),
    audit: await import('../../src/lib/audit'),
    secret: await import('../../src/lib/secret'),
  };
});

afterAll(async () => {
  await database.close();
  delete process.env.AUTH_RATE_LIMIT_ENABLED;
  vi.resetModules();
});

let userCounter = 0;

/** A new account with a password; the username is returned. */
async function createAccount(role: 'admin' | 'user' = 'user'): Promise<{ id: number; username: string }> {
  userCounter += 1;
  const username = `mfa-user-${userCounter}`;
  const user = await app.userModel.createUser({
    email: `${username}@example.com`,
    username,
    role,
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
  expect(res.body?.twoFactorRedirect).toBeUndefined();
  expect(b.has('session_token')).toBe(true);
  return b;
}

type Enrolled = { id: number; username: string; secret: string; backupCodes: string[] };

/** An account with MFA turned on through the Profile flow. */
async function enrolledAccount(role: 'admin' | 'user' = 'user'): Promise<Enrolled> {
  const account = await createAccount(role);
  const b = await signedIn(account.username);
  const enable = await b.post('/two-factor/enable', { password: PASSWORD });
  expect(enable.status).toBe(200);
  const secret = totpSecretFromUri(enable.body.totpURI);
  const verify = await b.post('/two-factor/verify-totp', { code: await totpCode(secret) });
  expect(verify.status).toBe(200);
  return { ...account, secret, backupCodes: enable.body.backupCodes };
}

async function startChallenge(username: string): Promise<AuthBrowser> {
  const b = browser();
  const res = await b.post('/sign-in/username', { username, password: PASSWORD });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ twoFactorRedirect: true, twoFactorMethods: ['totp'] });
  return b;
}

async function sessionCount(userId: number): Promise<number> {
  const { eq } = await import('drizzle-orm');
  return (await app.db.select().from(app.schema.sessions).where(eq(app.schema.sessions.userId, userId))).length;
}

async function twoFactorRow(userId: number) {
  const { eq } = await import('drizzle-orm');
  return await dbFirst(app.db.select().from(app.schema.twoFactors).where(eq(app.schema.twoFactors.userId, userId)).limit(1));
}

async function setStatus(userId: number, status: string) {
  const { eq } = await import('drizzle-orm');
  await app.db.update(app.schema.users).set({ status }).where(eq(app.schema.users.id, userId));
}

/** The login_success summaries recorded in the audit table for an account. */
async function signInRecords(userId: number): Promise<string[]> {
  const { and, eq } = await import('drizzle-orm');
  return (await app.db.select({ summary: app.schema.auditEvents.summary }).from(app.schema.auditEvents)
    .where(and(eq(app.schema.auditEvents.userId, userId), eq(app.schema.auditEvents.action, 'login_success'))))
    .map((row) => row.summary ?? '');
}

function auditActions(): Array<{ action: string; userId?: number | null; data?: unknown }> {
  return vi.mocked(app.audit.logAuditEvent).mock.calls.map(([event]) => event as never);
}

beforeEach(async () => {
  const { eq } = await import('drizzle-orm');
  await app.ssoStore.writeSsoEnforcement(app.db, { enabled: false, breakGlassUserIds: [] });
  await app.db.delete(app.schema.settings).where(eq(app.schema.settings.key, app.mfa.MFA_POLICY_SETTING_KEY));
  await app.mfaAuth.resetMfaRequestStateForTests();
  vi.mocked(app.audit.logAuditEvent).mockClear();
});

describe('enrolment', () => {
  it('needs the password, returns the authenticator URI and backup codes once, and turns MFA on after a valid code', async () => {
    const account = await createAccount();
    const b = await signedIn(account.username);

    expect((await b.post('/two-factor/enable', { password: WRONG })).status).toBe(400);
    expect(await twoFactorRow(account.id)).toBeUndefined();

    const enable = await b.post('/two-factor/enable', { password: PASSWORD, issuer: 'Evil Corp' });
    expect(enable.status).toBe(200);
    expect(enable.body.totpURI).toMatch(/^otpauth:\/\/totp\/Ingressi:/);
    expect(enable.body.totpURI).not.toContain('Evil');
    expect(enable.body.backupCodes).toHaveLength(10);
    const secret = totpSecretFromUri(enable.body.totpURI);

    // Not on yet: the first code has to be confirmed.
    expect((await app.mfa.getMfaStatus(account.id)).enabled).toBe(false);
    expect((await b.post('/two-factor/verify-totp', { code: '000000' })).status).toBe(401);
    expect((await app.mfa.getMfaStatus(account.id)).enabled).toBe(false);

    const verify = await b.post('/two-factor/verify-totp', { code: await totpCode(secret) });
    expect(verify.status).toBe(200);
    expect(await app.mfa.getMfaStatus(account.id)).toMatchObject({ enabled: true, backupCodesRemaining: 10 });
    expect(auditActions()).toContainEqual(expect.objectContaining({ action: 'mfa_enabled', userId: account.id }));
    // Turning MFA on replaced the session; the browser still has one.
    expect(b.has('session_token')).toBe(true);
    expect(await sessionCount(account.id)).toBe(1);
  });

  it('stores the secret and the backup codes encrypted', async () => {
    const account = await enrolledAccount();
    const row = (await twoFactorRow(account.id))!;
    expect(row.verified).toBe(true);
    expect(row.secret).not.toContain(account.secret);
    expect(row.secret).not.toBe(account.secret);
    expect(app.secret.isEncryptedSecret(row.backupCodes)).toBe(true);
    for (const code of account.backupCodes) expect(row.backupCodes).not.toContain(code);
    expect(JSON.parse(app.secret.decryptSecret(row.backupCodes))).toEqual(account.backupCodes);
  });

  it('never gives the secret back after enrolment', async () => {
    const account = await enrolledAccount();
    const b = await (async () => {
      const c = await startChallenge(account.username);
      await c.post('/two-factor/verify-totp', { code: await totpCode(account.secret, -1) });
      return c;
    })();
    const uri = await b.post('/two-factor/get-totp-uri', { password: PASSWORD });
    expect(uri.status).toBe(404);
    expect(JSON.stringify(uri.body ?? '')).not.toContain('otpauth');
    // Enabling again does not hand out a new secret for an enrolled account.
    const again = await b.post('/two-factor/enable', { password: PASSWORD });
    expect(again.status).toBe(400);
    expect(JSON.stringify(again.body)).not.toContain('otpauth');
    const status = JSON.stringify(await app.mfa.getMfaStatus(account.id));
    expect(status).not.toContain(account.secret);
    for (const code of account.backupCodes) expect(status).not.toContain(code);
  });

  it('cannot be set up by an account without a password', async () => {
    const { db, schema } = app;
    const now = new Date().toISOString();
    const [user] = await db.insert(schema.users).values({
      email: 'oauth-only@example.com', role: 'user', status: 'active', provider: 'oidc', subject: 'sub',
      createdAt: now, updatedAt: now,
    }).returning();
    const ctx = await (app.auth as unknown as { $context: Promise<{ internalAdapter: { createSession: (id: string) => Promise<{ token: string }> } }> }).$context;
    const session = await runWithEndpointContext({ path: '/callback/:id', context: ctx } as never,
      () => ctx.internalAdapter.createSession(String(user.id)));
    const b = browser();
    const { makeSignature } = await import('better-auth/crypto');
    b.cookies.set('better-auth.session_token', encodeURIComponent(`${session.token}.${await makeSignature(session.token, process.env.SESSION_SECRET!)}`));
    expect((await b.post('/two-factor/enable', { password: PASSWORD })).status).toBe(400);
    expect(await twoFactorRow(user.id)).toBeUndefined();
  });
});

describe('sign-in with MFA', () => {
  it('creates no session until the second factor is passed', async () => {
    const account = await enrolledAccount();
    const before = await sessionCount(account.id);
    const b = browser();
    const res = await b.post('/sign-in/username', { username: account.username, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ twoFactorRedirect: true, twoFactorMethods: ['totp'] });
    expect(b.has('session_token')).toBe(false);
    expect(b.has('two_factor')).toBe(true);
    expect(await sessionCount(account.id)).toBe(before);
    // The sign-in is only recorded once it completes; the enrolment's session
    // replacement is not recorded as one either.
    const recorded = await signInRecords(account.id);
    expect(recorded).toEqual(['User signed in']);
    const verify = await b.post('/two-factor/verify-totp', { code: await totpCode(account.secret) });
    expect(verify.status).toBe(200);
    expect(b.has('session_token')).toBe(true);
    expect(b.has('two_factor')).toBe(false);
    expect(await sessionCount(account.id)).toBe(before + 1);
    expect(await signInRecords(account.id)).toEqual([...recorded, 'User signed in with a second factor']);
  });

  it('also challenges the email sign-in endpoint', async () => {
    const account = await enrolledAccount();
    const b = browser();
    const res = await b.post('/sign-in/email', { email: `${account.username}@example.com`, password: PASSWORD });
    expect(res.body).toMatchObject({ twoFactorRedirect: true });
    expect(b.has('session_token')).toBe(false);
  });

  it('answers a wrong password as before, without a challenge', async () => {
    const account = await enrolledAccount();
    const b = browser();
    const res = await b.post('/sign-in/username', { username: account.username, password: WRONG });
    expect(res.status).toBe(401);
    expect(b.has('two_factor')).toBe(false);
  });

  it('refuses wrong and expired codes with the same answer', async () => {
    const account = await enrolledAccount();
    const b = await startChallenge(account.username);
    const wrong = await b.post('/two-factor/verify-totp', { code: '123456' });
    const expired = await b.post('/two-factor/verify-totp', { code: await totpCode(account.secret, -4) });
    expect(wrong.status).toBe(401);
    expect(expired).toMatchObject({ status: 401, body: wrong.body });
    expect(wrong.body).toMatchObject({ code: 'INVALID_CODE' });
    expect(b.has('session_token')).toBe(false);
    // The neighbouring time steps are accepted (clock drift).
    expect((await b.post('/two-factor/verify-totp', { code: await totpCode(account.secret, -1) })).status).toBe(200);
    expect(auditActions().filter((e) => e.action === 'mfa_verification_failed' && e.userId === account.id)).toHaveLength(2);
  });

  it('accepts codes typed with spaces', async () => {
    const account = await enrolledAccount();
    const b = await startChallenge(account.username);
    const code = await totpCode(account.secret);
    expect((await b.post('/two-factor/verify-totp', { code: `${code.slice(0, 3)} ${code.slice(3)}` })).status).toBe(200);
  });

  it('refuses a challenge that expired', async () => {
    const account = await enrolledAccount();
    const b = await startChallenge(account.username);
    const { like } = await import('drizzle-orm');
    await app.db.update(app.schema.verifications)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(like(app.schema.verifications.identifier, '2fa-%'));
    const res = await b.post('/two-factor/verify-totp', { code: await totpCode(account.secret) });
    expect(res.status).toBe(401);
    expect(b.has('session_token')).toBe(false);
  });

  it('refuses a TOTP code that already signed the account in', async () => {
    const account = await enrolledAccount();
    const code = await totpCode(account.secret);
    const first = await startChallenge(account.username);
    // The enrolment used the current code already; use the next window's one if it is the same.
    const res = await first.post('/two-factor/verify-totp', { code });
    const used = res.status === 200 ? code : await totpCode(account.secret, 1);
    if (res.status !== 200) {
      expect((await first.post('/two-factor/verify-totp', { code: used })).status).toBe(200);
    }
    const second = await startChallenge(account.username);
    const replay = await second.post('/two-factor/verify-totp', { code: used });
    expect(replay.status).toBe(401);
    expect(replay.body).toMatchObject({ code: 'INVALID_CODE' });
    expect(second.has('session_token')).toBe(false);
  });

  it('ignores "trust this device"', async () => {
    const account = await enrolledAccount();
    const b = await startChallenge(account.username);
    const res = await b.post('/two-factor/verify-totp', { code: await totpCode(account.secret, 1), trustDevice: true });
    expect(res.status).toBe(200);
    expect(b.has('trust_device')).toBe(false);
    // The next sign-in is challenged again.
    const next = browser();
    for (const [name, value] of b.cookies) if (!name.includes('session_token')) next.cookies.set(name, value);
    expect((await next.post('/sign-in/username', { username: account.username, password: PASSWORD })).body)
      .toMatchObject({ twoFactorRedirect: true });
  });

  it('does not challenge sessions from the identity provider', async () => {
    const account = await enrolledAccount();
    const ctx = await (app.auth as unknown as { $context: Promise<{ internalAdapter: { createSession: (id: string) => Promise<unknown> } }> }).$context;
    const before = await sessionCount(account.id);
    await runWithEndpointContext({ path: '/callback/:id', context: ctx } as never,
      () => ctx.internalAdapter.createSession(String(account.id)));
    expect(await sessionCount(account.id)).toBe(before + 1);
  });
});

describe('backup codes', () => {
  it('sign in once each', async () => {
    const account = await enrolledAccount();
    const [code] = account.backupCodes;
    const first = await startChallenge(account.username);
    expect((await first.post('/two-factor/verify-backup-code', { code: ` ${code} ` })).status).toBe(200);
    expect(first.has('session_token')).toBe(true);
    expect((await app.mfa.getMfaStatus(account.id)).backupCodesRemaining).toBe(9);
    expect(auditActions()).toContainEqual(expect.objectContaining({ action: 'mfa_backup_code_used', userId: account.id }));

    const second = await startChallenge(account.username);
    const reused = await second.post('/two-factor/verify-backup-code', { code });
    expect(reused.status).toBe(401);
    expect(second.has('session_token')).toBe(false);
    expect((await second.post('/two-factor/verify-backup-code', { code: account.backupCodes[1] })).status).toBe(200);
    expect((await app.mfa.getMfaStatus(account.id)).backupCodesRemaining).toBe(8);
  });

  it('cannot skip the session with disableSession', async () => {
    const account = await enrolledAccount();
    const b = await startChallenge(account.username);
    const res = await b.post('/two-factor/verify-backup-code', { code: account.backupCodes[0], disableSession: true });
    expect(res.status).toBe(200);
    // The challenge was used up with a real sign-in, not left open.
    expect(b.has('two_factor')).toBe(false);
    expect(b.has('session_token')).toBe(true);
  });

  it('are replaced when regenerated with the password', async () => {
    const account = await enrolledAccount();
    const b = await startChallenge(account.username);
    await b.post('/two-factor/verify-totp', { code: await totpCode(account.secret, 1) });
    expect((await b.post('/two-factor/generate-backup-codes', { password: WRONG })).status).toBe(400);
    const regenerated = await b.post('/two-factor/generate-backup-codes', { password: PASSWORD });
    expect(regenerated.status).toBe(200);
    expect(regenerated.body.backupCodes).toHaveLength(10);
    expect(auditActions()).toContainEqual(expect.objectContaining({ action: 'mfa_backup_codes_regenerated', userId: account.id }));

    const old = await startChallenge(account.username);
    expect((await old.post('/two-factor/verify-backup-code', { code: account.backupCodes[0] })).status).toBe(401);
    expect((await old.post('/two-factor/verify-backup-code', { code: regenerated.body.backupCodes[0] })).status).toBe(200);
  });
});

describe('attempt limits', () => {
  it('ends a challenge after 5 wrong codes', async () => {
    const account = await enrolledAccount();
    const b = await startChallenge(account.username);
    for (let i = 0; i < 5; i++) {
      expect((await b.post('/two-factor/verify-totp', { code: '000000' })).status).toBe(401);
    }
    const sixth = await b.post('/two-factor/verify-totp', { code: await totpCode(account.secret, 1) });
    expect(sixth.status).toBe(400);
    expect(sixth.body).toMatchObject({ code: 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE' });
    expect(b.has('session_token')).toBe(false);
  });

  it('locks the account for 15 minutes after 10 failures across challenges and factors', async () => {
    const account = await enrolledAccount();
    for (let i = 0; i < 10; i++) {
      const b = await startChallenge(account.username);
      const res = i % 2 === 0
        ? await b.post('/two-factor/verify-totp', { code: '000000' })
        : await b.post('/two-factor/verify-backup-code', { code: 'XXXXX-XXXXX' });
      expect(res.status).toBe(401);
    }
    const b = await startChallenge(account.username);
    const locked = await b.post('/two-factor/verify-totp', { code: await totpCode(account.secret, 1) });
    expect(locked.status).toBe(429);
    expect(b.has('session_token')).toBe(false);
    const row = (await twoFactorRow(account.id))!;
    expect(new Date(row.lockedUntil!).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);

    // An administrator's reset (or the lock running out) lets the user in again.
    await app.mfa.resetUserMfa(account.id);
    expect((await browser().post('/sign-in/username', { username: account.username, password: PASSWORD })).body?.twoFactorRedirect)
      .toBeUndefined();
  });
});

describe('account status and enforced SSO', () => {
  it('refuses the second step when the account was disabled meanwhile', async () => {
    const account = await enrolledAccount();
    const b = await startChallenge(account.username);
    await setStatus(account.id, 'disabled');
    const res = await b.post('/two-factor/verify-totp', { code: await totpCode(account.secret, 1) });
    expect(res.status).toBe(401);
    expect(b.has('session_token')).toBe(false);
    await setStatus(account.id, 'active');
  });

  it('requires the second factor from a break-glass account', async () => {
    const account = await enrolledAccount('admin');
    await app.ssoStore.writeSsoEnforcement(app.db, { enabled: true, breakGlassUserIds: [account.id] });
    const b = await startChallenge(account.username);
    expect(b.has('session_token')).toBe(false);
    expect((await b.post('/two-factor/verify-totp', { code: '000000' })).status).toBe(401);
    expect((await b.post('/two-factor/verify-totp', { code: await totpCode(account.secret, 1) })).status).toBe(200);
    expect(b.has('session_token')).toBe(true);
  });

  it('refuses a non-break-glass account at the password, before any challenge', async () => {
    const account = await enrolledAccount();
    await app.ssoStore.writeSsoEnforcement(app.db, { enabled: true, breakGlassUserIds: [] });
    const b = browser();
    const correct = await b.post('/sign-in/username', { username: account.username, password: PASSWORD });
    const wrong = await browser().post('/sign-in/username', { username: account.username, password: WRONG });
    expect(correct.status).toBe(401);
    expect(correct.body).toEqual(wrong.body);
    expect(b.has('two_factor')).toBe(false);
  });

  it('lets an existing session turn MFA off while SSO is enforced', async () => {
    const account = await enrolledAccount();
    const b = await startChallenge(account.username);
    await b.post('/two-factor/verify-totp', { code: await totpCode(account.secret, 1) });
    await app.ssoStore.writeSsoEnforcement(app.db, { enabled: true, breakGlassUserIds: [] });
    const res = await b.post('/two-factor/disable', { password: PASSWORD });
    expect(res.status).toBe(200);
    expect((await app.mfa.getMfaStatus(account.id)).enabled).toBe(false);
    expect(b.has('session_token')).toBe(true);
  });
});

describe('turning MFA off', () => {
  it('is refused while the MFA policy requires it for the account', async () => {
    const account = await enrolledAccount('admin');
    const b = await startChallenge(account.username);
    await b.post('/two-factor/verify-totp', { code: await totpCode(account.secret, 1) });
    await app.db.insert(app.schema.settings).values({
      key: app.mfa.MFA_POLICY_SETTING_KEY,
      value: JSON.stringify({ scope: 'admins', graceDays: 7, since: new Date().toISOString() }),
      updatedAt: new Date().toISOString(),
    });
    const res = await b.post('/two-factor/disable', { password: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MFA_REQUIRED_BY_POLICY' });
    expect((await app.mfa.getMfaStatus(account.id)).enabled).toBe(true);
  });

  it('needs the password and removes the secret and the backup codes', async () => {
    const account = await enrolledAccount();
    const b = await startChallenge(account.username);
    await b.post('/two-factor/verify-totp', { code: await totpCode(account.secret, 1) });
    expect((await b.post('/two-factor/disable', { password: WRONG })).status).toBe(400);
    expect((await app.mfa.getMfaStatus(account.id)).enabled).toBe(true);
    expect((await b.post('/two-factor/disable', { password: PASSWORD })).status).toBe(200);
    expect(await twoFactorRow(account.id)).toBeUndefined();
    expect((await app.mfa.getMfaStatus(account.id)).enabled).toBe(false);
    expect(auditActions()).toContainEqual(expect.objectContaining({ action: 'mfa_disabled', userId: account.id }));
    const next = browser();
    expect((await next.post('/sign-in/username', { username: account.username, password: PASSWORD })).body?.twoFactorRedirect)
      .toBeUndefined();
    expect(next.has('session_token')).toBe(true);
  });
});
