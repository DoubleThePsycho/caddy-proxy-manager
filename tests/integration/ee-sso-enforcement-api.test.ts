/**
 * Enforced SSO configuration (ee/sso): GET/PUT /api/v1/sso/enforcement and the
 * dashboard server action. Turning enforcement on, or changing it
 * while on, needs an enabled OAuth/OIDC provider. Break-glass accounts are
 * optional; the listed ones must exist and be able to sign in with a password.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { createTestDb, disableForeignKeys, type TestDb } from '../helpers/db';
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
import { readSsoEnforcement, writeSsoEnforcement } from '@/ee/sso/enforcement-store';
import { NO_SSO_PROVIDER_MESSAGE } from '@/ee/sso/enforcement';

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
  users.root = (await seed('root')).id;
  users.ops = (await seed('ops')).id;
  users.viewer = (await seed('viewer', 'user')).id;
  users.nopass = (await seed('nopass', 'admin', false)).id;
  ctx.sessionUserId = users.root;
});

async function put(body: unknown) {
  const response = await PUT(request('PUT', body));
  return { status: response.status, data: await response.json() };
}

describe('GET /api/v1/sso/enforcement', () => {
  it('shows the setting', async () => {
    await addProvider();
    await writeSsoEnforcement(ctx.db, { enabled: true, breakGlassUserIds: [users.ops] });
    const response = await GET(request('GET'));
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data).toMatchObject({
      enabled: true,
      breakGlassUsernames: ['ops'],
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

describe('the server action', () => {
  it('turns enforcement on', async () => {
    await addProvider();
    const result = await saveSsoEnforcementAction({ enabled: true, breakGlassUsernames: ['ops'] });
    expect(result).toMatchObject({ ok: true, view: { enabled: true, breakGlassUsernames: ['ops'] } });
    expect(await readSsoEnforcement(ctx.db)).toEqual({ enabled: true, breakGlassUserIds: [users.ops] });
  });
});

describe('PUT /api/v1/sso/enforcement', () => {
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

  it('turns it on without any break-glass account', async () => {
    await addProvider();
    const { status, data } = await put({ enabled: true, breakGlassUsernames: [] });
    expect(status).toBe(200);
    expect(data).toMatchObject({ enabled: true, breakGlassUsernames: [], breakGlassAccounts: [], warnings: [] });
    expect(await readSsoEnforcement(ctx.db)).toEqual({ enabled: true, breakGlassUserIds: [] });
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'sso_enforcement_updated',
      summary: 'Turned on enforced SSO for dashboard sign-in (break-glass accounts: none)',
    }));
  });

  it('turns it on with the list omitted and none stored', async () => {
    await addProvider();
    expect((await put({ enabled: true })).data).toMatchObject({ enabled: true, breakGlassUsernames: [] });
    expect(await readSsoEnforcement(ctx.db)).toEqual({ enabled: true, breakGlassUserIds: [] });
  });

  it('turns it on with only a non-admin break-glass account', async () => {
    await addProvider();
    const { status, data } = await put({ enabled: true, breakGlassUsernames: ['viewer'] });
    expect(status).toBe(200);
    expect(data.breakGlassAccounts).toEqual([expect.objectContaining({ id: users.viewer, passwordSignIn: true, validAdmin: false })]);
    expect(data.warnings).toEqual([]);
  });

  it('accepts a disabled administrator as a break-glass account, which does not count as a valid administrator', async () => {
    await addProvider();
    await ctx.db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, users.ops));
    const { status, data } = await put({ enabled: true, breakGlassUsernames: ['ops'] });
    expect(status).toBe(200);
    expect(data.breakGlassAccounts).toEqual([expect.objectContaining({ id: users.ops, status: 'disabled', validAdmin: false })]);
  });

  it('turns it on through the server action without a break-glass account', async () => {
    await addProvider();
    expect(await saveSsoEnforcementAction({ enabled: true, breakGlassUsernames: [] })).toMatchObject({
      ok: true, view: { enabled: true, breakGlassUsernames: [] },
    });
    expect(await readSsoEnforcement(ctx.db)).toEqual({ enabled: true, breakGlassUserIds: [] });
  });

  it('warns when no provider is enabled while on, saying whether a break-glass account can still sign in', async () => {
    await writeSsoEnforcement(ctx.db, { enabled: true, breakGlassUserIds: [users.ops] });
    expect((await (await GET(request('GET'))).json()).warnings).toEqual([
      'No OAuth/OIDC or SAML provider is enabled, so only break-glass accounts can sign in.',
    ]);
    await writeSsoEnforcement(ctx.db, { enabled: true, breakGlassUserIds: [] });
    expect((await (await GET(request('GET'))).json()).warnings).toEqual([
      'No OAuth/OIDC or SAML provider is enabled and no break-glass account can sign in. Enable a provider or turn enforced SSO off.',
    ]);
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

  it('lets the break-glass administrators be removed while on', async () => {
    await addProvider();
    expect((await put({ enabled: true, breakGlassUsernames: ['ops'] })).status).toBe(200);
    expect((await put({ enabled: true, breakGlassUsernames: ['viewer'] })).status).toBe(200);
    expect(await readSsoEnforcement(ctx.db)).toEqual({ enabled: true, breakGlassUserIds: [users.viewer] });
    expect((await put({ enabled: true, breakGlassUsernames: [] })).status).toBe(200);
    expect(await readSsoEnforcement(ctx.db)).toEqual({ enabled: true, breakGlassUserIds: [] });
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
      ['enabled', 'breakGlassUsernames', 'breakGlassAccounts', 'ssoProviders', 'warnings']
    );
  });
});
