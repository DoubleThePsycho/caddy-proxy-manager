/**
 * The MFA policy ("require MFA for administrators / for everyone who signs in
 * with a password") with its grace period, the administrator's reset, and the
 * REST endpoints: /api/v1/mfa, /api/v1/mfa/policy and /api/v1/users/{id}/mfa.
 * None of them ever returns an authenticator secret or a backup code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db');
  ctx.db = createTestDb();
  return (await import('../helpers/db-module')).mockDbModule(() => ctx.db);
});

vi.mock('../../src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-auth')>();
  return { ...actual, requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))), requireApiAdmin: vi.fn(), requireApiUser: vi.fn() };
});

const authMocks = vi.hoisted(() => ({ requireAdmin: vi.fn() }));
vi.mock('@/src/lib/auth', () => ({ requirePermission: vi.fn(() => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireAdmin())), requireAdmin: authMocks.requireAdmin, auth: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { eq } from 'drizzle-orm';
import * as schema from '../../src/lib/db/schema';
import { ApiAuthError, requireApiAdmin, requireApiUser } from '../../src/lib/api-auth';
import { logAuditEvent } from '../../src/lib/audit';
import { encryptSecret } from '../../src/lib/secret';
import { writeSsoEnforcement } from '../../ee/sso/enforcement-store';
import {
  MFA_POLICY_SETTING_KEY,
  getMfaGate,
  getMfaStatus,
  mfaEnrolmentRequired,
  parseMfaPolicy,
  readMfaPolicy,
  updateMfaPolicy,
} from '../../src/lib/mfa';
import { GET as getOwnStatus } from '../../app/api/v1/mfa/route';
import { GET as getPolicy, PUT as putPolicy } from '../../app/api/v1/mfa/policy/route';
import { DELETE as resetUserMfaRoute, GET as getUserMfa } from '../../app/api/v1/users/[id]/mfa/route';
import { resetUserMfaAction, updateMfaPolicyAction } from '../../app/(dashboard)/users/mfa-actions';
import { first as dbFirst } from '@/src/lib/db/ops';

const DAY = 24 * 60 * 60 * 1000;
const SECRET_SENTINEL = 'totp-secret-sentinel-JBSWY3DPEHPK3PXP';
const BACKUP_CODES = ['AAAAA-11111', 'BBBBB-22222', 'CCCCC-33333'];

let counter = 0;

/** An account; with a password unless `password` is false. */
async function seedUser(role: 'admin' | 'user' | 'viewer', { password = true } = {}): Promise<number> {
  counter += 1;
  const now = new Date().toISOString();
  const email = `user${counter}@example.com`;
  const [user] = await ctx.db.insert(schema.users).values({
    email, name: `User ${counter}`, role, status: 'active', provider: password ? 'credentials' : 'oidc',
    subject: email, username: `user${counter}`, createdAt: now, updatedAt: now,
  }).returning();
  if (password) {
    await ctx.db.insert(schema.accounts).values({
      userId: user.id, issuer: 'credential', accountId: String(user.id), providerId: 'credential',
      password: '$2a$04$hash', createdAt: now, updatedAt: now,
    });
  }
  return user.id;
}

/** MFA as the two-factor plugin leaves it once set up. */
async function enrol(userId: number, { verified = true } = {}) {
  await ctx.db.insert(schema.twoFactors).values({
    userId, secret: SECRET_SENTINEL, backupCodes: encryptSecret(JSON.stringify(BACKUP_CODES)), verified,
  });
  await ctx.db.update(schema.users).set({ twoFactorEnabled: verified }).where(eq(schema.users.id, userId));
}

async function setPolicy(value: unknown) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  await ctx.db.insert(schema.settings).values({ key: MFA_POLICY_SETTING_KEY, value: raw, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: raw } });
}

function asAdmin(userId: number) {
  vi.mocked(requireApiAdmin).mockResolvedValue({ userId, role: 'admin', authMethod: 'bearer' });
  vi.mocked(requireApiUser).mockResolvedValue({ userId, role: 'admin', authMethod: 'bearer' });
}

function asUser(userId: number) {
  vi.mocked(requireApiAdmin).mockRejectedValue(new ApiAuthError('Administrator privileges required', 403));
  vi.mocked(requireApiUser).mockResolvedValue({ userId, role: 'user', authMethod: 'session' });
}

function request(path: string, init: { method?: string; body?: unknown } = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    ...(init.body !== undefined ? { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) } : {}),
  });
}

const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

function expectNoSecrets(json: unknown) {
  const text = JSON.stringify(json);
  expect(text).not.toContain(SECRET_SENTINEL);
  for (const code of BACKUP_CODES) expect(text).not.toContain(code);
  expect(text).not.toContain('enc:v1:');
}

beforeEach(async () => {
  for (const table of [schema.twoFactors, schema.accounts, schema.sessions, schema.settings, schema.users]) {
    await ctx.db.delete(table);
  }
  vi.mocked(logAuditEvent).mockClear();
  vi.mocked(requireApiAdmin).mockReset();
  vi.mocked(requireApiUser).mockReset();
  authMocks.requireAdmin.mockReset();
});

describe('stored policy', () => {
  it('is off without a row, and fails closed when the row cannot be read', async () => {
    expect(await readMfaPolicy()).toMatchObject({ scope: 'off', since: null });
    for (const raw of ['not json', '[]', '{"scope":"everyone","graceDays":3}', '{"scope":"admins","graceDays":-1}']) {
      expect(parseMfaPolicy(raw)).toMatchObject({ scope: 'password_users', graceDays: 0 });
    }
    expect(parseMfaPolicy('{"scope":"admins","graceDays":3,"since":"2026-01-01T00:00:00.000Z"}'))
      .toEqual({ scope: 'admins', graceDays: 3, since: '2026-01-01T00:00:00.000Z' });
  });
});

describe('policy enforcement', () => {
  it('asks nothing while the policy is off', async () => {
    const admin = await seedUser('admin');
    expect(await getMfaGate(admin)).toEqual({ gate: 'none', deadline: null });
    expect(await mfaEnrolmentRequired(admin)).toBe(false);
  });

  it('prompts covered accounts during the grace period and requires MFA after it', async () => {
    const admin = await seedUser('admin');
    const user = await seedUser('user');
    const since = new Date(Date.now() - 2 * DAY).toISOString();
    await setPolicy({ scope: 'admins', graceDays: 7, since });

    const gate = await getMfaGate(admin);
    expect(gate.gate).toBe('prompt');
    expect(gate.deadline).toBe(new Date(Date.parse(since) + 7 * DAY).toISOString());
    expect((await getMfaGate(user)).gate).toBe('none');
    expect(await mfaEnrolmentRequired(admin)).toBe(false);

    expect((await getMfaGate(admin, new Date(Date.now() + 6 * DAY))).gate).toBe('required');
    await setPolicy({ scope: 'admins', graceDays: 1, since });
    expect((await getMfaGate(admin)).gate).toBe('required');
    expect(await mfaEnrolmentRequired(admin)).toBe(true);
    expect(await mfaEnrolmentRequired(user)).toBe(false);

    await setPolicy({ scope: 'password_users', graceDays: 0, since });
    expect(await mfaEnrolmentRequired(user)).toBe(true);
  });

  it('stops asking once the account has MFA, but not for an unconfirmed setup', async () => {
    const admin = await seedUser('admin');
    await setPolicy({ scope: 'admins', graceDays: 0, since: new Date(0).toISOString() });
    await enrol(admin, { verified: false });
    expect((await getMfaGate(admin)).gate).toBe('required');
    await ctx.db.delete(schema.twoFactors);
    await enrol(admin);
    expect((await getMfaGate(admin)).gate).toBe('none');
    expect(await getMfaStatus(admin)).toMatchObject({ enabled: true, required: true, gate: 'none', backupCodesRemaining: 3 });
  });

  it('never covers accounts without a password, which sign in through their identity provider', async () => {
    const oauthAdmin = await seedUser('admin', { password: false });
    await setPolicy({ scope: 'password_users', graceDays: 0, since: new Date(0).toISOString() });
    expect((await getMfaGate(oauthAdmin)).gate).toBe('none');
    expect(await getMfaStatus(oauthAdmin)).toMatchObject({ hasPassword: false, required: false });
  });

  it('under enforced SSO covers only break-glass accounts, the only ones that keep password sign-in', async () => {
    const breakGlass = await seedUser('admin');
    const ssoAdmin = await seedUser('admin');
    await setPolicy({ scope: 'admins', graceDays: 0, since: new Date(0).toISOString() });
    await writeSsoEnforcement(ctx.db, { enabled: true, breakGlassUserIds: [breakGlass] });
    expect((await getMfaGate(breakGlass)).gate).toBe('required');
    expect((await getMfaGate(ssoAdmin)).gate).toBe('none');
  });
});

describe('changing the policy', () => {
  it('starts the grace period when the scope changes and keeps it when only the days change', async () => {
    const admin = await seedUser('admin');
    const first = await updateMfaPolicy({ scope: 'admins', graceDays: 5 }, admin);
    expect(first.since).not.toBeNull();
    expect(first.deadline).toBe(new Date(Date.parse(first.since!) + 5 * DAY).toISOString());
    expect(first.accounts).toMatchObject({ required: 1, enrolled: 0 });
    expect(first.accounts.pending.map((account) => account.id)).toEqual([admin]);

    await setPolicy({ ...await readMfaPolicy(), since: '2026-01-01T00:00:00.000Z' });
    expect((await updateMfaPolicy({ scope: 'admins', graceDays: 9 }, admin)).since).toBe('2026-01-01T00:00:00.000Z');
    expect(await updateMfaPolicy({ scope: 'password_users' }, admin)).toMatchObject({ graceDays: 9 });
    expect((await readMfaPolicy()).since).not.toBe('2026-01-01T00:00:00.000Z');
    expect(await updateMfaPolicy({ scope: 'off' }, admin)).toMatchObject({ scope: 'off', since: null, deadline: null });
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'mfa_policy_updated', userId: admin }));
  });
});

describe('GET and PUT /api/v1/mfa/policy', () => {
  it('reads and saves the policy for administrators', async () => {
    const admin = await seedUser('admin');
    await enrol(admin);
    asAdmin(admin);
    const empty = await (await getPolicy(request('/api/v1/mfa/policy'))).json();
    expect(empty).toMatchObject({ scope: 'off', graceDays: 7, since: null, deadline: null });

    const res = await putPolicy(request('/api/v1/mfa/policy', { method: 'PUT', body: { scope: 'admins', graceDays: 14 } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ scope: 'admins', graceDays: 14, accounts: { required: 1, enrolled: 1, pending: [] } });
    expectNoSecrets(body);
  });

  it('validates the body', async () => {
    asAdmin(await seedUser('admin'));
    for (const body of [
      'not json',
      { scope: 'everyone' },
      { scope: 'admins', graceDays: 91 },
      { scope: 'admins', graceDays: 1.5 },
      { scope: 'admins', graceDays: '3' },
      { scope: 'admins', extra: true },
      [],
    ]) {
      const res = await putPolicy(request('/api/v1/mfa/policy', { method: 'PUT', body }));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await readMfaPolicy()).scope).toBe('off');
  });

  it('is for administrators only', async () => {
    asUser(await seedUser('user'));
    expect((await getPolicy(request('/api/v1/mfa/policy'))).status).toBe(403);
    expect((await putPolicy(request('/api/v1/mfa/policy', { method: 'PUT', body: { scope: 'off' } }))).status).toBe(403);
  });
});

describe('MFA state endpoints', () => {
  it('GET /api/v1/mfa reports the caller without secrets', async () => {
    const user = await seedUser('user');
    await enrol(user);
    asUser(user);
    const res = await getOwnStatus(request('/api/v1/mfa'));
    const body = await res.json();
    expect(body).toEqual({
      enabled: true, authenticatorApp: true, passkeys: 0, backupCodesRemaining: 3, hasPassword: true, required: false, gate: 'none', deadline: null,
    });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expectNoSecrets(body);
  });

  it('GET /api/v1/users/{id}/mfa is for administrators and the user themself', async () => {
    const admin = await seedUser('admin');
    const user = await seedUser('user');
    const other = await seedUser('user');
    await enrol(other);
    asAdmin(admin);
    const res = await getUserMfa(request(`/api/v1/users/${other}/mfa`), params(other));
    expect(res.status).toBe(200);
    expectNoSecrets(await res.json());
    expect((await getUserMfa(request('/api/v1/users/9999/mfa'), params(9999))).status).toBe(404);
    expect((await getUserMfa(request('/api/v1/users/abc/mfa'), params('abc'))).status).toBe(404);

    asUser(user);
    expect((await getUserMfa(request(`/api/v1/users/${user}/mfa`), params(user))).status).toBe(200);
    expect((await getUserMfa(request(`/api/v1/users/${other}/mfa`), params(other))).status).toBe(403);
  });
});

describe('administrator reset', () => {
  it('DELETE /api/v1/users/{id}/mfa turns MFA off and records it', async () => {
    const admin = await seedUser('admin');
    const user = await seedUser('user');
    await enrol(user);
    asAdmin(admin);
    const res = await resetUserMfaRoute(request(`/api/v1/users/${user}/mfa`, { method: 'DELETE' }), params(user));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ enabled: false, backupCodesRemaining: null });
    expectNoSecrets(body);
    expect(await dbFirst(ctx.db.select().from(schema.twoFactors).where(eq(schema.twoFactors.userId, user)).limit(1))).toBeUndefined();
    const row = await dbFirst(ctx.db.select().from(schema.users).where(eq(schema.users.id, user)).limit(1));
    expect(row?.twoFactorEnabled).toBe(false);
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'mfa_reset', userId: admin, entityType: 'user', entityId: user,
    }));
  });

  it('refuses the administrator\'s own account, unknown users and non-administrators', async () => {
    const admin = await seedUser('admin');
    await enrol(admin);
    asAdmin(admin);
    const self = await resetUserMfaRoute(request(`/api/v1/users/${admin}/mfa`, { method: 'DELETE' }), params(admin));
    expect(self.status).toBe(400);
    expect((await getMfaStatus(admin)).enabled).toBe(true);
    expect((await resetUserMfaRoute(request('/api/v1/users/9999/mfa', { method: 'DELETE' }), params(9999))).status).toBe(404);

    const user = await seedUser('user');
    asUser(user);
    expect((await resetUserMfaRoute(request(`/api/v1/users/${admin}/mfa`, { method: 'DELETE' }), params(admin))).status).toBe(403);
    expect((await getMfaStatus(admin)).enabled).toBe(true);
    expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'mfa_reset' }));
  });

  it('works from the Users page actions, which report problems inline', async () => {
    const admin = await seedUser('admin');
    const user = await seedUser('user');
    await enrol(user);
    authMocks.requireAdmin.mockResolvedValue({ user: { id: String(admin), role: 'admin' } });
    expect(await resetUserMfaAction(user)).toEqual({ ok: true });
    expect((await getMfaStatus(user)).enabled).toBe(false);
    expect(await resetUserMfaAction(admin)).toMatchObject({ ok: false });
    expect(await updateMfaPolicyAction('admins', 3)).toEqual({ ok: true });
    expect(await readMfaPolicy()).toMatchObject({ scope: 'admins', graceDays: 3 });
    expect(await updateMfaPolicyAction('nobody', 3)).toMatchObject({ ok: false, error: expect.stringContaining('scope') });
  });
});
