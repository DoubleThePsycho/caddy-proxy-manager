/**
 * REST endpoints of LDAP / Active Directory directories: the license gate on
 * setting up, enabling and changing a directory (and none on reading,
 * testing, disabling and deleting), validation, the service account password
 * never leaving the server, deleting a directory's account links with it,
 * the test endpoints against a fake directory, and SESSION_SECRET rotation.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { installLicense, licenseSigner } from '../helpers/config-fixture';
import { fakeLdap, group, person } from '../helpers/fake-ldap';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  config: null as null | { sessionSecret: string; previousSessionSecrets: string[] },
}));

vi.mock('ldapts', async (importOriginal) => {
  const { fakeLdapModule } = await import('../helpers/fake-ldap');
  return fakeLdapModule(await importOriginal<typeof import('ldapts')>());
});

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

vi.mock('../../src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-auth')>();
  return {
    ...actual,
    requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
    requireApiAdmin: vi.fn(),
  };
});

import { requireApiAdmin } from '../../src/lib/api-auth';
import { logAuditEvent } from '../../src/lib/audit';
import { decryptSecret } from '../../src/lib/secret';
import { setTrustedLicenseKeysForTests } from '../../ee/licensing/public-keys';
import * as listRoute from '../../app/api/v1/ldap-directories/route';
import * as detailRoute from '../../app/api/v1/ldap-directories/[id]/route';
import * as testRoute from '../../app/api/v1/ldap-directories/[id]/test/route';
import * as testSignInRoute from '../../app/api/v1/ldap-directories/[id]/test-sign-in/route';
import { first } from '@/src/lib/db/ops';

const SERVICE_PASSWORD = fakeLdap.servicePassword;
const LICENSE_ERROR = 'LDAP / Active Directory needs an active Ingressi Enterprise license or higher';

let adminId: number;

function now() {
  return new Date().toISOString();
}

beforeEach(async () => {
  ctx.db = createTestDb();
  vi.clearAllMocks();
  fakeLdap.reset();
  setTrustedLicenseKeysForTests(licenseSigner.keys);
  await installLicense(ctx.db, 'enterprise');
  adminId = (await first(ctx.db.insert(schema.users).values({
    email: 'admin@example.com', role: 'admin', status: 'active', createdAt: now(), updatedAt: now(),
  }).returning()))!.id;
  vi.mocked(requireApiAdmin).mockResolvedValue({ userId: adminId, role: 'admin', authMethod: 'bearer' } as never);
});

afterAll(() => setTrustedLicenseKeysForTests(null));

function req(method: string, path: string, body?: unknown): NextRequest {
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers: {} };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  return new NextRequest(`http://localhost${path}`, init);
}

const params = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });

const body = (overrides: Record<string, unknown> = {}) => ({
  name: 'Corp LDAP',
  url: 'ldaps://ldap.example.com:636',
  bindDn: fakeLdap.serviceDn,
  bindPassword: SERVICE_PASSWORD,
  userSearchBase: 'ou=people,dc=example,dc=com',
  userSearchFilter: '(&(objectClass=inetOrgPerson)(uid={username}))',
  provisionUsers: true,
  ...overrides,
});

async function create(overrides: Record<string, unknown> = {}): Promise<{ id: number }> {
  const response = await listRoute.POST(req('POST', '/api/v1/ldap-directories', body(overrides)));
  expect(response.status).toBe(201);
  return response.json();
}

async function removeLicense() {
  await ctx.db.delete(schema.settings).where(eq(schema.settings.key, 'license'));
}

describe('license gate', () => {
  it('refuses creating, changing and enabling without a license', async () => {
    const { id } = await create();
    const disabled = await create({ name: 'Disabled', enabled: false });
    await removeLicense();

    const responses = [
      await listRoute.POST(req('POST', '/api/v1/ldap-directories', body({ name: 'New' }))),
      await detailRoute.PUT(req('PUT', `/api/v1/ldap-directories/${id}`, { name: 'Renamed' }), params(id)),
      await detailRoute.PUT(req('PUT', `/api/v1/ldap-directories/${id}`, { enabled: false, allowWhenSsoEnforced: true }), params(id)),
      await detailRoute.PUT(req('PUT', `/api/v1/ldap-directories/${disabled.id}`, { enabled: true }), params(disabled.id)),
    ];
    for (const response of responses) {
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe(LICENSE_ERROR);
    }
    expect((await ctx.db.select().from(schema.ldapDirectories)).map((row) => [row.name, row.enabled]).sort())
      .toEqual([['Corp LDAP', true], ['Disabled', false]]);
  });

  it('is not enough with a Business license', async () => {
    await installLicense(ctx.db, 'business');
    const response = await listRoute.POST(req('POST', '/api/v1/ldap-directories', body()));
    expect(response.status).toBe(403);
  });

  it('lets an unlicensed admin read, test, disable and delete directories', async () => {
    const { id } = await create();
    fakeLdap.entries.push(person('alice'));
    await removeLicense();

    expect((await listRoute.GET(req('GET', '/api/v1/ldap-directories'))).status).toBe(200);
    expect((await detailRoute.GET(req('GET', `/api/v1/ldap-directories/${id}`), params(id))).status).toBe(200);
    expect((await testRoute.POST(req('POST', `/api/v1/ldap-directories/${id}/test`), params(id))).status).toBe(200);
    const signIn = await testSignInRoute.POST(
      req('POST', `/api/v1/ldap-directories/${id}/test-sign-in`, { username: 'alice', password: 'alice-password' }),
      params(id)
    );
    expect(signIn.status).toBe(200);

    const off = await detailRoute.PUT(req('PUT', `/api/v1/ldap-directories/${id}`, { enabled: false, name: 'Corp LDAP' }), params(id));
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ enabled: false });
    expect((await detailRoute.DELETE(req('DELETE', `/api/v1/ldap-directories/${id}`), params(id))).status).toBe(204);
    expect(await ctx.db.select().from(schema.ldapDirectories)).toEqual([]);
  });
});

describe('storage and validation', () => {
  it('stores the service account password encrypted and never returns it', async () => {
    const created = await create();
    expect(created).toMatchObject({ hasBindPassword: true, linkedAccounts: 0, enabled: true, startTls: false });
    expect(JSON.stringify(created)).not.toContain(SERVICE_PASSWORD);
    expect(created).not.toHaveProperty('bindPassword');
    const row = (await first(ctx.db.select().from(schema.ldapDirectories).limit(1)))!;
    expect(row.bindPassword).not.toContain(SERVICE_PASSWORD);
    expect(decryptSecret(row.bindPassword)).toBe(SERVICE_PASSWORD);

    const listed = await (await listRoute.GET(req('GET', '/api/v1/ldap-directories'))).text();
    expect(listed).not.toContain(SERVICE_PASSWORD);
    expect(listed).not.toContain(row.bindPassword);
    expect(vi.mocked(logAuditEvent).mock.calls.some(([event]) => JSON.stringify(event).includes(SERVICE_PASSWORD))).toBe(false);
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(expect.objectContaining({ action: 'ldap_directory_created', userId: adminId }));
  });

  it('answers 400 for invalid settings and 409 for a name in use', async () => {
    await create();
    const invalid = [
      body({ url: 'ldap://ldap.example.com', startTls: false }),
      body({ userSearchFilter: '({username}=x)' }),
      body({ defaultRole: 'admin' }),
      body({ name: 'Other', unexpected: true }),
    ];
    for (const payload of invalid) {
      expect((await listRoute.POST(req('POST', '/api/v1/ldap-directories', payload))).status).toBe(400);
    }
    expect((await listRoute.POST(req('POST', '/api/v1/ldap-directories', '{not json'))).status).toBe(400);
    expect((await listRoute.POST(req('POST', '/api/v1/ldap-directories', body()))).status).toBe(409);
    expect((await detailRoute.GET(req('GET', '/api/v1/ldap-directories/abc'), params('abc'))).status).toBe(404);
    expect((await detailRoute.GET(req('GET', '/api/v1/ldap-directories/99'), params(99))).status).toBe(404);
  });

  it('keeps the stored password on update and asks for it again when the URL changes', async () => {
    const { id } = await create();
    const before = (await first(ctx.db.select().from(schema.ldapDirectories).limit(1)))!.bindPassword;
    const renamed = await detailRoute.PUT(req('PUT', `/api/v1/ldap-directories/${id}`, { name: 'Renamed', bindPassword: '' }), params(id));
    expect(renamed.status).toBe(200);
    expect((await first(ctx.db.select().from(schema.ldapDirectories).limit(1)))!.bindPassword).toBe(before);
    const moved = await detailRoute.PUT(req('PUT', `/api/v1/ldap-directories/${id}`, { url: 'ldaps://ldap.example.org' }), params(id));
    expect(moved.status).toBe(400);
  });

  it('deletes the account links of a deleted directory and keeps the users', async () => {
    const { id } = await create();
    const other = await create({ name: 'Other' });
    const userId = (await first(ctx.db.insert(schema.users).values({
      email: 'linked@example.com', role: 'user', status: 'active', provider: `ldap:${id}`, subject: 'uuid-1', createdAt: now(), updatedAt: now(),
    }).returning()))!.id;
    for (const [providerId, accountId] of [[`ldap:${id}`, 'uuid-1'], [`ldap:${other.id}`, 'uuid-1'], ['credential', String(userId)]]) {
      await ctx.db.insert(schema.accounts).values({
        userId, providerId, accountId, issuer: `x:${providerId}`, createdAt: now(), updatedAt: now(),
      });
    }
    expect((await (await detailRoute.GET(req('GET', `/api/v1/ldap-directories/${id}`), params(id))).json()).linkedAccounts).toBe(1);

    expect((await detailRoute.DELETE(req('DELETE', `/api/v1/ldap-directories/${id}`), params(id))).status).toBe(204);
    const left = (await ctx.db.select().from(schema.accounts).where(eq(schema.accounts.userId, userId))).map((row) => row.providerId).sort();
    expect(left).toEqual(['credential', `ldap:${other.id}`]);
    expect(await first(ctx.db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1))).toMatchObject({ provider: `ldap:${other.id}` });
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ldap_directory_deleted', data: expect.objectContaining({ unlinkedUserIds: [userId] }),
    }));
  });
});

describe('test endpoints', () => {
  it('tests the connection step by step', async () => {
    const { id } = await create();
    fakeLdap.entries.push(person('alice'));
    const ok = await (await testRoute.POST(req('POST', `/api/v1/ldap-directories/${id}/test`), params(id))).json();
    expect(ok).toEqual({
      ok: true,
      steps: [
        { step: 'connect', ok: true, detail: 'connected with TLS' },
        { step: 'bind', ok: true, detail: 'service account accepted' },
        { step: 'search_base', ok: true, detail: 'user search base found' },
      ],
    });
    fakeLdap.servicePassword = 'rotated';
    try {
      const failed = await (await testRoute.POST(req('POST', `/api/v1/ldap-directories/${id}/test`), params(id))).json();
      expect(failed).toMatchObject({ ok: false, steps: [{ step: 'connect', ok: true }, { step: 'bind', ok: false, detail: 'invalid credentials (LDAP result 49)' }] });
    } finally {
      fakeLdap.servicePassword = SERVICE_PASSWORD;
    }
  });

  it('tests a sign-in without signing anyone in or creating an account', async () => {
    const { id } = await create({
      groupMode: 'search',
      groupSearchBase: 'ou=groups,dc=example,dc=com',
      groupSearchFilter: '(member={dn})',
      groupRoleMappings: [{ group: 'cn=admins,ou=groups,dc=example,dc=com', role: 'admin' }],
    });
    const alice = person('alice');
    fakeLdap.entries.push(alice, group('admins', [alice.dn]));
    const usersBefore = (await ctx.db.select().from(schema.users)).length;

    const ok = await (await testSignInRoute.POST(
      req('POST', `/api/v1/ldap-directories/${id}/test-sign-in`, { username: 'alice', password: 'alice-password' }),
      params(id)
    )).json();
    expect(ok).toMatchObject({
      ok: true,
      outcome: 'success',
      user: { dn: alice.dn, username: 'alice', email: 'alice@example.com', groups: ['cn=admins,ou=groups,dc=example,dc=com'] },
      roles: { role: 'admin', managesRoles: true, inRequiredGroup: true },
      account: { action: 'provision', userId: null, reason: null },
    });
    expect(JSON.stringify(ok)).not.toContain('alice-password');

    const wrong = await (await testSignInRoute.POST(
      req('POST', `/api/v1/ldap-directories/${id}/test-sign-in`, { username: 'alice', password: 'nope' }),
      params(id)
    )).json();
    expect(wrong).toMatchObject({ ok: false, outcome: 'wrong_password', user: null });
    const unknown = await (await testSignInRoute.POST(
      req('POST', `/api/v1/ldap-directories/${id}/test-sign-in`, { username: 'nobody', password: 'nope' }),
      params(id)
    )).json();
    expect(unknown).toMatchObject({ ok: false, outcome: 'unknown_user' });

    expect((await ctx.db.select().from(schema.users)).length).toBe(usersBefore);
    expect(await ctx.db.select().from(schema.sessions)).toEqual([]);
    expect(vi.mocked(logAuditEvent).mock.calls.filter(([event]) => event.action === 'ldap_directory_sign_in_tested')).toHaveLength(3);
    expect(vi.mocked(logAuditEvent).mock.calls.some(([event]) => JSON.stringify(event).includes('alice-password'))).toBe(false);

    expect((await testSignInRoute.POST(
      req('POST', `/api/v1/ldap-directories/${id}/test-sign-in`, { username: 'alice' }),
      params(id)
    )).status).toBe(400);
  });
});

describe('SESSION_SECRET rotation', () => {
  it('re-encrypts the service account password', async () => {
    vi.resetModules();
    const OLD = 'old-operator-secret-abcdefghijklmnopqrstuvwxyz';
    const NEW = 'new-operator-secret-zyxwvutsrqponmlkjihgfedcba';
    vi.doMock('../../src/lib/config', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../src/lib/config')>()),
      config: (ctx.config = { sessionSecret: OLD, previousSessionSecrets: [] }),
    }));
    const secret = await import('../../src/lib/secret');
    const { reencryptStoredSecrets } = await import('../../src/lib/secret-rotation');
    const stored = secret.encryptSecret('bind-secret');
    await ctx.db.insert(schema.ldapDirectories).values({
      name: 'Rotating', url: 'ldaps://ldap.example.com', bindDn: 'cn=x,dc=example,dc=com', bindPassword: stored,
      userSearchBase: 'dc=example,dc=com', userSearchFilter: '(uid={username})', createdAt: now(), updatedAt: now(),
    });

    ctx.config!.sessionSecret = NEW;
    ctx.config!.previousSessionSecrets = [OLD];
    expect(await reencryptStoredSecrets()).toMatchObject({ failed: 0 });
    ctx.config!.previousSessionSecrets = [];
    const row = (await first(ctx.db.select().from(schema.ldapDirectories).limit(1)))!;
    expect(row.bindPassword).not.toBe(stored);
    expect(secret.reencryptSecret(row.bindPassword)).toBeNull();
    expect(secret.decryptSecret(row.bindPassword)).toBe('bind-secret');
    vi.doUnmock('../../src/lib/config');
    vi.resetModules();
  });
});
