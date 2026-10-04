/**
 * Enforced SSO configuration (ee/sso): GET/PUT /api/v1/sso/enforcement and the
 * dashboard server action. Changing the setting needs a license that includes
 * sso_enforce; reading it does not. Turning enforcement on, or changing it
 * while on, needs an enabled OAuth/OIDC provider and at least one break-glass
 * account that is an active administrator with a password.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { createTestDb, disableForeignKeys, type TestDb } from '../helpers/db';
import { createTestSigner, licensePayload, signLicense } from '../helpers/license';
import * as schema from '../../src/lib/db/schema';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  sessionUserId: 1,
}));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/src/lib/auth', () => ({
  auth: vi.fn(),
  requirePermission: vi.fn(() => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireAdmin())),
  requireAdmin: vi.fn(async () => ({ user: { id: String(ctx.sessionUserId), role: 'admin' } })),
}));
vi.mock('@/src/lib/api-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/api-auth')>()),
  requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
  requireApiAdmin: vi.fn(async () => ({ userId: ctx.sessionUserId, role: 'admin', authMethod: 'bearer' })),
}));

import { GET, PUT } from '@/app/api/v1/sso/enforcement/route';
import { GET as getOpenApi } from '@/app/api/v1/openapi.json/route';
import { saveSsoEnforcementAction } from '@/ee/sso/ui/actions';
import { requireApiAdmin, ApiAuthError } from '@/src/lib/api-auth';
import { logAuditEvent } from '@/src/lib/audit';
import { createUser } from '@/src/lib/models/user';
import { setTrustedLicenseKeysForTests } from '@/ee/licensing/public-keys';
import { LICENSE_SETTING_KEY } from '@/ee/licensing/store';
import { readSsoEnforcement, writeSsoEnforcement } from '@/ee/sso/enforcement-store';
import { NO_BREAK_GLASS_ADMIN_MESSAGE, NO_SSO_PROVIDER_MESSAGE } from '@/ee/sso/enforcement';

const signer = createTestSigner();
const PASSWORD_HASH = bcrypt.hashSync('Correct-Horse-9!', 4);

function request(method: string, body?: unknown): any {
  return {
    method,
    headers: { get: () => null },
    nextUrl: { pathname: '/api/v1/sso/enforcement', searchParams: new URLSearchParams() },
    json: async () => {
      if (body === undefined) throw new SyntaxError('no body');
      return body;
    },
  };
}

async function installLicense(overrides: Record<string, unknown> = {}) {
  const key = signLicense(signer, licensePayload(signer, {
    iat: '2026-01-01T00:00:00.000Z', exp: '2099-01-01T00:00:00.000Z', ...overrides,
  }));
  const now = new Date().toISOString();
  await ctx.db.insert(schema.settings).values({ key: LICENSE_SETTING_KEY, value: JSON.stringify(key), updatedAt: now })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify(key), updatedAt: now } });
}

async function addProvider(enabled = true) {
  const now = new Date().toISOString();
  await ctx.db.insert(schema.oauthProviders).values({
    id: 'dex', name: 'Dex', clientId: 'x', clientSecret: 'y', issuer: 'https://dex.example.com', enabled, createdAt: now, updatedAt: now,
  });
}

async function seed(username: string, role: 'admin' | 'user' = 'admin', withPassword = true) {
  return createUser({
    email: `${username}@example.com`, username, role, provider: 'credentials', subject: username,
    passwordHash: withPassword ? PASSWORD_HASH : null,
  });
}

const users = { root: 0, ops: 0, viewer: 0, nopass: 0 };

beforeEach(async () => {
  ctx.db = createTestDb();
  await disableForeignKeys(ctx.db);
  vi.mocked(logAuditEvent).mockClear();
  setTrustedLicenseKeysForTests(signer.keys);
  users.root = (await seed('root')).id;
  users.ops = (await seed('ops')).id;
  users.viewer = (await seed('viewer', 'user')).id;
  users.nopass = (await seed('nopass', 'admin', false)).id;
  ctx.sessionUserId = users.root;
});

afterAll(() => setTrustedLicenseKeysForTests(null));

async function put(body: unknown) {
  const response = await PUT(request('PUT', body));
  return { status: response.status, data: await response.json() };
}

describe('GET /api/v1/sso/enforcement', () => {
  it('shows the setting read-only without a license', async () => {
    await addProvider();
    await writeSsoEnforcement(ctx.db, { enabled: true, breakGlassUserIds: [users.ops] });
    const response = await GET(request('GET'));
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data).toMatchObject({
      enabled: true,
      breakGlassUsernames: ['ops'],
      configurable: false,
      ssoProviders: [{ id: 'dex', name: 'Dex', kind: 'oidc' }],
    });
    expect(data.breakGlassAccounts[0]).toMatchObject({ id: users.ops, role: 'admin', passwordSignIn: true, validAdmin: true });
    expect(JSON.stringify(data)).not.toContain(PASSWORD_HASH);
  });

  it('requires an administrator', async () => {
    vi.mocked(requireApiAdmin).mockRejectedValueOnce(new ApiAuthError('Administrator privileges required', 403));
    expect((await GET(request('GET'))).status).toBe(403);
  });
});

describe('license gate', () => {
  it.each([
    ['no license', async () => {}],
    ['a license past its grace period', async () => await installLicense({ iat: '2020-01-01T00:00:00.000Z', exp: '2021-01-01T00:00:00.000Z' })],
    ['a Homelab license', async () => await installLicense({ edition: 'homelab' })],
  ])('refuses every change through the API with %s', async (_name, setup) => {
    await setup();
    await addProvider();
    for (const body of [
      { enabled: true, breakGlassUsernames: ['ops'] },
      { enabled: true },
    ]) {
      const { status, data } = await put(body);
      expect(status).toBe(403);
      expect(data.error).toBe('Enforced SSO needs an active Ingressi Business license or higher');
    }
    expect(await readSsoEnforcement(ctx.db)).toEqual({ enabled: false, breakGlassUserIds: [] });
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it('lets an administrator turn enforcement off without a license, keeping the break-glass list', async () => {
    await addProvider();
    await writeSsoEnforcement(ctx.db, { enabled: true, breakGlassUserIds: [users.ops] });
    expect((await put({ enabled: false, breakGlassUsernames: [] })).status).toBe(200);
    expect(await readSsoEnforcement(ctx.db)).toEqual({ enabled: false, breakGlassUserIds: [users.ops] });
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'sso_enforcement_updated' }));
  });

  it('refuses the server action without a license, and accepts it with one', async () => {
    await addProvider();
    expect(await saveSsoEnforcementAction({ enabled: true, breakGlassUsernames: ['ops'] })).toEqual({
      ok: false, error: 'Enforced SSO needs an active Ingressi Business license or higher',
    });
    expect((await readSsoEnforcement(ctx.db)).enabled).toBe(false);

    await installLicense();
    const result = await saveSsoEnforcementAction({ enabled: true, breakGlassUsernames: ['ops'] });
    expect(result).toMatchObject({ ok: true, view: { enabled: true, breakGlassUsernames: ['ops'], configurable: true } });
    expect(await readSsoEnforcement(ctx.db)).toEqual({ enabled: true, breakGlassUserIds: [users.ops] });
  });

  it('accepts changes during the grace period of an expired license', async () => {
    const graceExpiry = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    await installLicense({ iat: '2025-01-01T00:00:00.000Z', exp: graceExpiry });
    await addProvider();
    expect((await put({ enabled: true, breakGlassUsernames: ['ops'] })).status).toBe(200);
  });
});

describe('PUT /api/v1/sso/enforcement with a license', () => {
  beforeEach(async () => await installLicense());

  it('turns enforcement on, stores ids, audits the change and returns the view', async () => {
    await addProvider();
    const { status, data } = await put({ enabled: true, breakGlassUsernames: ['  OPS ', 'viewer'] });
    expect(status).toBe(200);
    expect(data).toMatchObject({ enabled: true, breakGlassUsernames: ['ops', 'viewer'], warnings: [] });
    expect(await readSsoEnforcement(ctx.db)).toEqual({ enabled: true, breakGlassUserIds: [users.ops, users.viewer] });
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      userId: users.root,
      action: 'sso_enforcement_updated',
      entityType: 'sso_enforcement',
      summary: 'Turned on enforced SSO for dashboard sign-in (break-glass accounts: ops, viewer)',
    }));
  });

  it('refuses turning it on without an enabled SSO provider', async () => {
    await addProvider(false);
    const { status, data } = await put({ enabled: true, breakGlassUsernames: ['ops'] });
    expect(status).toBe(400);
    expect(data.error).toBe(NO_SSO_PROVIDER_MESSAGE);
    expect((await readSsoEnforcement(ctx.db)).enabled).toBe(false);
  });

  it.each([
    ['no break-glass account', []],
    ['only a non-admin', ['viewer']],
  ])('refuses turning it on with %s', async (_name, names) => {
    await addProvider();
    const { status, data } = await put({ enabled: true, breakGlassUsernames: names });
    expect(status).toBe(400);
    expect(data.error).toBe(NO_BREAK_GLASS_ADMIN_MESSAGE);
  });

  it('refuses a disabled administrator as the only break-glass account', async () => {
    await addProvider();
    await ctx.db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, users.ops));
    const { status, data } = await put({ enabled: true, breakGlassUsernames: ['ops'] });
    expect(status).toBe(400);
    expect(data.error).toBe(NO_BREAK_GLASS_ADMIN_MESSAGE);
  });

  it('refuses unknown usernames and accounts without a password', async () => {
    await addProvider();
    expect(await put({ enabled: true, breakGlassUsernames: ['ops', 'ghost'] })).toEqual({
      status: 400, data: { error: 'No account signs in with the username "ghost"' },
    });
    expect(await put({ enabled: true, breakGlassUsernames: ['ops', 'nopass'] })).toEqual({
      status: 400, data: { error: 'The account "nopass" cannot sign in with a password. Give it a password first.' },
    });
    expect((await readSsoEnforcement(ctx.db)).enabled).toBe(false);
  });

  it('refuses changes that would leave no valid break-glass administrator while on', async () => {
    await addProvider();
    expect((await put({ enabled: true, breakGlassUsernames: ['ops'] })).status).toBe(200);
    const { status, data } = await put({ enabled: true, breakGlassUsernames: ['viewer'] });
    expect(status).toBe(400);
    expect(data.error).toBe(NO_BREAK_GLASS_ADMIN_MESSAGE);
    expect(await readSsoEnforcement(ctx.db)).toEqual({ enabled: true, breakGlassUserIds: [users.ops] });
  });

  it('keeps the break-glass accounts when the list is omitted', async () => {
    await addProvider();
    await put({ enabled: true, breakGlassUsernames: ['ops'] });
    expect((await put({ enabled: false })).data).toMatchObject({ enabled: false, breakGlassUsernames: ['ops'] });
    expect((await put({ enabled: true })).data).toMatchObject({ enabled: true, breakGlassUsernames: ['ops'] });
  });

  it('always allows turning enforcement off', async () => {
    await writeSsoEnforcement(ctx.db, { enabled: true, breakGlassUserIds: [] });
    const { status, data } = await put({ enabled: false, breakGlassUsernames: [] });
    expect(status).toBe(200);
    expect(data.enabled).toBe(false);
  });

  it.each([
    ['no body', undefined],
    ['an array', []],
    ['a missing enabled flag', { breakGlassUsernames: ['ops'] }],
    ['a string flag', { enabled: 'true' }],
    ['a non-array list', { enabled: true, breakGlassUsernames: 'ops' }],
    ['a non-string name', { enabled: true, breakGlassUsernames: [1] }],
    ['too many names', { enabled: true, breakGlassUsernames: Array.from({ length: 21 }, (_, i) => `u${i}`) }],
  ])('rejects %s with 400', async (_name, body) => {
    expect((await PUT(request('PUT', body))).status).toBe(400);
  });
});

describe('OpenAPI', () => {
  it('documents both operations under the SSO tag', async () => {
    const spec = await (await getOpenApi(request('GET'))).json();
    expect(spec.tags).toContainEqual(expect.objectContaining({ name: 'SSO' }));
    const path = spec.paths['/api/v1/sso/enforcement'];
    expect(path.get).toMatchObject({ operationId: 'getSsoEnforcement', tags: ['SSO'] });
    expect(path.put).toMatchObject({ operationId: 'updateSsoEnforcement', tags: ['SSO'] });
    expect(path.put.requestBody.content['application/json'].schema).toEqual({ $ref: '#/components/schemas/SsoEnforcementInput' });
    expect(Object.keys(spec.components.schemas.SsoEnforcement.properties)).toEqual(
      ['enabled', 'breakGlassUsernames', 'breakGlassAccounts', 'ssoProviders', 'warnings', 'configurable']
    );
  });
});
