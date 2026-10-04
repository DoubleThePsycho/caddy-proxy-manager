/**
 * REST endpoints of SAML providers (/api/v1/saml-providers): the license
 * gate on creating, enabling and changing a provider (and none on reading,
 * disabling and deleting), validation, IdP metadata parsed on save, the SP
 * signing key never leaving the server, the SP metadata, deleting a
 * provider's accounts and mappings with it, SESSION_SECRET rotation, enforced
 * SSO counting SAML providers, SCIM choosing one, and the permission guards
 * through the real role resolution.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { installLicense, licenseSigner } from '../helpers/config-fixture';
import { createTestKey, idpMetadataXml, IDP_ENTITY_ID, IDP_SSO_URL, type TestKey } from '../helpers/saml-idp';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  config: null as null | { sessionSecret: string; previousSessionSecrets: string[] },
  /** Bearer token -> the user it authenticates. */
  tokens: new Map<string, { id: number; role: string; customRoleId: number | null }>(),
}));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('@/src/lib/models/api-tokens', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/models/api-tokens')>()),
  validateToken: vi.fn(async (raw: string) => {
    const user = ctx.tokens.get(raw);
    return user ? { token: { id: 1, name: 'test', createdBy: user.id }, user } : null;
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { logAuditEvent } from '../../src/lib/audit';
import { decryptSecret } from '../../src/lib/secret';
import { createUser } from '../../src/lib/models/user';
import { setTrustedLicenseKeysForTests } from '../../ee/licensing/public-keys';
import { listEnabledSsoProviders, updateSsoEnforcement } from '../../ee/sso/enforcement';
import { serviceProviderUrls } from '../../ee/saml/store';
import { updateScimSettings } from '../../ee/scim/service';
import * as listRoute from '../../app/api/v1/saml-providers/route';
import * as detailRoute from '../../app/api/v1/saml-providers/[id]/route';
import * as metadataRoute from '../../app/api/v1/saml-providers/[id]/metadata/route';
import { first } from '@/src/lib/db/ops';

const LICENSE_ERROR = 'SAML single sign-on needs an active Ingressi Business license or higher';

/** A P-256 certificate (openssl req -x509 -newkey ec), for the RSA-only check. */
const EC_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBiDCCAS+gAwIBAgIUXFZqhM06xY35syzENP6RdHotasswCgYIKoZIzj0EAwIw
GTEXMBUGA1UEAwwOZWMuZXhhbXBsZS5jb20wIBcNMjYxMDAzMDkwMzM1WhgPMjEy
NjA5MDkwOTAzMzVaMBkxFzAVBgNVBAMMDmVjLmV4YW1wbGUuY29tMFkwEwYHKoZI
zj0CAQYIKoZIzj0DAQcDQgAEUT8ub6MmdUo+5+7PfOx3Bd62uWpcUmgHhKPGXkj3
nzDaHp2bPHBF4ab0nMG4649ZmfFhf5MuQU4RXe1OA4LF5aNTMFEwHQYDVR0OBBYE
FEiLek1BiaZNvwnYWktwG5xs8zE/MB8GA1UdIwQYMBaAFEiLek1BiaZNvwnYWktw
G5xs8zE/MA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDRwAwRAIgPDgqoQe+
/GEeBYDYZb5udrAZIO31We3zReJnJ8j+KycCIGfSf7qnmsm9hMSRvC9Q3uN1hgY5
O/0WY9OCqLQ8S/1T
-----END CERTIFICATE-----`;
const ADMIN_TOKEN = 'admin-token';
const VIEWER_TOKEN = 'viewer-token';

let adminId: number;
let idp: TestKey;
let idpNext: TestKey;

function now() {
  return new Date().toISOString();
}

beforeEach(async () => {
  ctx.db = createTestDb();
  vi.mocked(logAuditEvent).mockClear();
  setTrustedLicenseKeysForTests(licenseSigner.keys);
  await installLicense(ctx.db, 'business');
  adminId = (await createUser({
    email: 'admin@example.com', username: 'admin', role: 'admin', provider: 'credentials', subject: 'admin',
    passwordHash: bcrypt.hashSync('Correct-Horse-9!', 4),
  })).id;
  const viewerId = (await first(ctx.db.insert(schema.users).values({
    email: 'viewer@example.com', role: 'viewer', status: 'active', createdAt: now(), updatedAt: now(),
  }).returning()))!.id;
  ctx.tokens.clear();
  ctx.tokens.set(ADMIN_TOKEN, { id: adminId, role: 'admin', customRoleId: null });
  ctx.tokens.set(VIEWER_TOKEN, { id: viewerId, role: 'viewer', customRoleId: null });
  idp ??= createTestKey('idp.example.com');
  idpNext ??= createTestKey('idp-next.example.com');
});

afterAll(() => setTrustedLicenseKeysForTests(null));

function req(method: string, path: string, body?: unknown, token = ADMIN_TOKEN): NextRequest {
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers: { authorization: `Bearer ${token}` } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  return new NextRequest(`http://localhost${path}`, init);
}

const params = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });

const body = (overrides: Record<string, unknown> = {}) => ({
  name: 'Corp IdP',
  idpEntityId: IDP_ENTITY_ID,
  idpSsoUrl: IDP_SSO_URL,
  idpCertificates: [idp.certificate],
  groupsAttribute: 'groups',
  groupRoleMappings: [{ group: 'ingressi-admins', role: 'admin' }],
  ...overrides,
});

async function create(overrides: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const response = await listRoute.POST(req('POST', '/api/v1/saml-providers', body(overrides)));
  expect(response.status, await response.clone().text()).toBe(201);
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
      await listRoute.POST(req('POST', '/api/v1/saml-providers', body({ name: 'New' }))),
      await detailRoute.PUT(req('PUT', `/api/v1/saml-providers/${id}`, { name: 'Renamed' }), params(id)),
      await detailRoute.PUT(req('PUT', `/api/v1/saml-providers/${id}`, { enabled: false, provisionUsers: true }), params(id)),
      await detailRoute.PUT(req('PUT', `/api/v1/saml-providers/${disabled.id}`, { enabled: true }), params(disabled.id)),
      await detailRoute.PUT(req('PUT', `/api/v1/saml-providers/${id}`, { enabled: false, generateSpKey: true }), params(id)),
    ];
    for (const response of responses) {
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe(LICENSE_ERROR);
    }
    expect((await ctx.db.select().from(schema.samlProviders)).map((row) => [row.name, row.enabled]).sort())
      .toEqual([['Corp IdP', true], ['Disabled', false]]);
  });

  it('is not included in the Homelab edition', async () => {
    await installLicense(ctx.db, 'homelab');
    expect((await listRoute.POST(req('POST', '/api/v1/saml-providers', body()))).status).toBe(403);
  });

  it('lets an unlicensed admin read, download the metadata, disable and delete providers', async () => {
    const { id } = await create();
    await removeLicense();
    expect((await listRoute.GET(req('GET', '/api/v1/saml-providers'))).status).toBe(200);
    expect((await detailRoute.GET(req('GET', `/api/v1/saml-providers/${id}`), params(id))).status).toBe(200);
    expect((await metadataRoute.GET(req('GET', `/api/v1/saml-providers/${id}/metadata`), params(id))).status).toBe(200);
    const off = await detailRoute.PUT(req('PUT', `/api/v1/saml-providers/${id}`, { enabled: false, name: 'Corp IdP' }), params(id));
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ enabled: false });
    expect((await detailRoute.DELETE(req('DELETE', `/api/v1/saml-providers/${id}`), params(id))).status).toBe(204);
    expect(await ctx.db.select().from(schema.samlProviders)).toEqual([]);
  });
});

describe('permissions', () => {
  it('refuses a viewer every read and write, and lets an administrator through', async () => {
    const { id } = await create();
    const viewerCalls = [
      listRoute.GET(req('GET', '/api/v1/saml-providers', undefined, VIEWER_TOKEN)),
      listRoute.POST(req('POST', '/api/v1/saml-providers', body({ name: 'Viewer IdP' }), VIEWER_TOKEN)),
      detailRoute.GET(req('GET', `/api/v1/saml-providers/${id}`, undefined, VIEWER_TOKEN), params(id)),
      detailRoute.PUT(req('PUT', `/api/v1/saml-providers/${id}`, { provisionUsers: true }, VIEWER_TOKEN), params(id)),
      detailRoute.DELETE(req('DELETE', `/api/v1/saml-providers/${id}`, undefined, VIEWER_TOKEN), params(id)),
      metadataRoute.GET(req('GET', `/api/v1/saml-providers/${id}/metadata`, undefined, VIEWER_TOKEN), params(id)),
    ];
    for (const response of await Promise.all(viewerCalls)) expect(response.status).toBe(403);
    expect((await ctx.db.select().from(schema.samlProviders)).map((row) => row.name)).toEqual(['Corp IdP']);
    expect((await listRoute.GET(req('GET', '/api/v1/saml-providers'))).status).toBe(200);
  });
});

describe('storage and validation', () => {
  it('derives the SP URLs from BASE_URL and stores mappings explicitly', async () => {
    const created = await create();
    expect(created).toMatchObject({
      enabled: true,
      idpEntityId: IDP_ENTITY_ID,
      hasSpPrivateKey: false,
      signsRequests: false,
      linkedAccounts: 0,
      provisionUsers: false,
      linkExistingAccounts: false,
      defaultRole: 'user',
      emailAttribute: 'email',
      subjectAttribute: null,
      groupRoleMappings: [{ group: 'ingressi-admins', role: 'admin' }],
      sp: serviceProviderUrls(created.id),
    });
    expect(created.sp.acsUrl.endsWith(`/api/auth/saml/acs/${created.id}`)).toBe(true);
    expect(created.sp.entityId.endsWith(`/api/auth/saml/metadata/${created.id}`)).toBe(true);
    expect(created.certificates[0]).toMatchObject({ subject: 'CN=idp.example.com', expired: false });
    expect((await ctx.db.select().from(schema.samlGroupRoles)).map((row) => [row.providerId, row.groupValue, row.role]))
      .toEqual([[created.id, 'ingressi-admins', 'admin']]);
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(expect.objectContaining({ action: 'saml_provider_created', userId: adminId }));
  });

  it('reads the entity ID, the HTTP-Redirect URL and the certificates from IdP metadata, once', async () => {
    const created = await create({
      idpEntityId: undefined, idpSsoUrl: undefined, idpCertificates: undefined,
      idpMetadataXml: idpMetadataXml([idp.certificate, idpNext.certificate], { ssoUrl: 'https://idp.example.com/sso/redirect' }),
    });
    expect(created).toMatchObject({ idpEntityId: IDP_ENTITY_ID, idpSsoUrl: 'https://idp.example.com/sso/redirect' });
    expect(created.idpCertificates).toHaveLength(2);
    // The metadata itself is not kept.
    expect(JSON.stringify(await first(ctx.db.select().from(schema.samlProviders).limit(1)))).not.toContain('EntityDescriptor');
  });

  it('answers 400 for invalid settings and metadata, and 409 for a name in use', async () => {
    await create();
    const invalid = [
      body({ name: 'A', idpSsoUrl: 'http://idp.example.com/sso' }),
      body({ name: 'B', idpSsoUrl: 'javascript:alert(1)' }),
      body({ name: 'C', idpCertificates: [idp.privateKey] }),
      body({ name: 'D', idpCertificates: ['not a certificate'] }),
      body({ name: 'E', idpCertificates: [] }),
      body({ name: 'F', groupsAttribute: null }),
      body({ name: 'G', groupsAttribute: null, groupRoleMappings: [], requiredGroup: 'x' }),
      body({ name: 'H', defaultRole: 'admin' }),
      body({ name: 'I', groupRoleMappings: [{ group: 'a', role: 'owner' }] }),
      body({ name: 'J', groupRoleMappings: [{ group: 'a', role: 'user' }, { group: 'a', role: 'admin' }] }),
      body({ name: 'K', emailAttribute: 'has space' }),
      body({ name: 'L', unexpected: true }),
      body({ name: 'M', idpEntityId: undefined, idpSsoUrl: undefined, idpCertificates: undefined, idpMetadataXml: '<!DOCTYPE x><x/>' }),
      body({ name: 'N', idpEntityId: undefined, idpSsoUrl: undefined, idpCertificates: undefined, idpMetadataXml: idpMetadataXml([idp.certificate], { postOnly: true }) }),
      body({ name: 'O', idpEntityId: undefined, idpSsoUrl: undefined, idpCertificates: undefined, idpMetadataXml: idpMetadataXml([]) }),
      body({ name: 'P', spPrivateKey: idp.privateKey, spCertificate: idpNext.certificate }),
      body({ name: 'Q', generateSpKey: true, spPrivateKey: idp.privateKey, spCertificate: idp.certificate }),
      body({ name: '' }),
    ];
    for (const payload of invalid) {
      const response = await listRoute.POST(req('POST', '/api/v1/saml-providers', payload));
      expect(response.status, JSON.stringify(payload).slice(0, 80)).toBe(400);
    }
    expect((await listRoute.POST(req('POST', '/api/v1/saml-providers', '{not json'))).status).toBe(400);
    expect((await listRoute.POST(req('POST', '/api/v1/saml-providers', body()))).status).toBe(409);
    expect((await detailRoute.GET(req('GET', '/api/v1/saml-providers/abc'), params('abc'))).status).toBe(404);
    expect((await detailRoute.GET(req('GET', '/api/v1/saml-providers/99'), params(99))).status).toBe(404);
    // A loopback test IdP may use http.
    expect((await listRoute.POST(req('POST', '/api/v1/saml-providers', body({ name: 'Local', idpSsoUrl: 'http://localhost:8089/sso' })))).status).toBe(201);
  });

  it('refuses an EC signing certificate (xml-crypto verifies RSA only)', async () => {
    const response = await listRoute.POST(req('POST', '/api/v1/saml-providers', body({ name: 'EC', idpCertificates: [EC_CERTIFICATE] })));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/RSA/);
  });

  it('generates an SP signing key, stores it encrypted and never returns it', async () => {
    const created = await create({ generateSpKey: true });
    expect(created).toMatchObject({ hasSpPrivateKey: true, signsRequests: true });
    expect(created.spCertificate).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect(created).not.toHaveProperty('spPrivateKey');
    const row = (await first(ctx.db.select().from(schema.samlProviders).limit(1)))!;
    expect(row.spPrivateKey).not.toContain('PRIVATE KEY');
    const privateKey = decryptSecret(row.spPrivateKey!);
    expect(privateKey).toMatch(/^-----BEGIN PRIVATE KEY-----/);

    const listed = await (await listRoute.GET(req('GET', '/api/v1/saml-providers'))).text();
    expect(listed).not.toContain(privateKey.split('\n')[1]);
    expect(listed).not.toContain(row.spPrivateKey!);
    expect(vi.mocked(logAuditEvent).mock.calls.some(([event]) => JSON.stringify(event).includes(privateKey.split('\n')[1]))).toBe(false);

    // Kept across an update that does not mention it, replaced by a given key, removed with null.
    await detailRoute.PUT(req('PUT', `/api/v1/saml-providers/${created.id}`, { provisionUsers: true }), params(created.id));
    expect((await first(ctx.db.select().from(schema.samlProviders).limit(1)))!.spPrivateKey).toBe(row.spPrivateKey);
    const given = await detailRoute.PUT(
      req('PUT', `/api/v1/saml-providers/${created.id}`, { spPrivateKey: idpNext.privateKey, spCertificate: idpNext.certificate }),
      params(created.id)
    );
    expect(given.status).toBe(200);
    expect(decryptSecret((await first(ctx.db.select().from(schema.samlProviders).limit(1)))!.spPrivateKey!)).toContain('PRIVATE KEY');
    const removed = await (await detailRoute.PUT(req('PUT', `/api/v1/saml-providers/${created.id}`, { spPrivateKey: null }), params(created.id))).json();
    expect(removed).toMatchObject({ hasSpPrivateKey: false, signsRequests: false, spCertificate: null });
  });

  it('serves the SP metadata with the signing certificate when requests are signed', async () => {
    const created = await create({ generateSpKey: true });
    const response = await metadataRoute.GET(req('GET', `/api/v1/saml-providers/${created.id}/metadata`), params(created.id));
    expect(response.headers.get('content-type')).toContain('application/samlmetadata+xml');
    const xml = await response.text();
    expect(xml).toContain(`entityID="${created.sp.entityId}"`);
    expect(xml).toContain('AuthnRequestsSigned="true"');
    expect(xml).toContain('<md:KeyDescriptor use="signing">');
    expect(xml).toContain(`Location="${created.sp.acsUrl}"`);
    expect(xml).toContain('urn:oasis:names:tc:SAML:2.0:nameid-format:persistent');
    expect(xml).not.toContain('PRIVATE');
  });

  it('deletes the provider\'s account links, mappings, sign-ins in progress and replay records, and keeps the users', async () => {
    const { id } = await create();
    const other = await create({ name: 'Other' });
    const userId = (await first(ctx.db.insert(schema.users).values({
      email: 'linked@example.com', role: 'user', status: 'active', provider: `saml:${id}`, subject: 'subject-1', createdAt: now(), updatedAt: now(),
    }).returning()))!.id;
    for (const [providerId, accountId] of [[`saml:${id}`, 'subject-1'], [`saml:${other.id}`, 'subject-1'], ['credential', String(userId)]]) {
      await ctx.db.insert(schema.accounts).values({ userId, providerId, accountId, issuer: `x:${providerId}`, createdAt: now(), updatedAt: now() });
    }
    const later = new Date(Date.now() + 60_000).toISOString();
    await ctx.db.insert(schema.samlRequests).values({ providerId: id, requestId: '_r1', bindingHash: 'h1', callbackUrl: '/', createdAt: now(), expiresAt: later });
    await ctx.db.insert(schema.samlUsedAssertions).values({ providerId: id, assertionId: '_a1', expiresAt: later, createdAt: now() });
    expect((await (await detailRoute.GET(req('GET', `/api/v1/saml-providers/${id}`), params(id))).json()).linkedAccounts).toBe(1);

    expect((await detailRoute.DELETE(req('DELETE', `/api/v1/saml-providers/${id}`), params(id))).status).toBe(204);
    const left = (await ctx.db.select().from(schema.accounts).where(eq(schema.accounts.userId, userId))).map((row) => row.providerId).sort();
    expect(left).toEqual(['credential', `saml:${other.id}`]);
    expect((await ctx.db.select().from(schema.samlGroupRoles)).map((row) => row.providerId)).toEqual([other.id]);
    expect(await ctx.db.select().from(schema.samlRequests)).toEqual([]);
    expect(await ctx.db.select().from(schema.samlUsedAssertions)).toEqual([]);
    expect(await first(ctx.db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1))).toMatchObject({ provider: `saml:${other.id}` });
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(expect.objectContaining({
      action: 'saml_provider_deleted', data: expect.objectContaining({ unlinkedUserIds: [userId] }),
    }));
  });
});

describe('enforced SSO and SCIM', () => {
  it('counts enabled SAML providers as identity providers for enforced SSO', async () => {
    const created = await create();
    expect(await listEnabledSsoProviders(ctx.db)).toEqual([{ id: `saml:${created.id}`, name: 'Corp IdP', kind: 'saml' }]);
    const view = await updateSsoEnforcement({ enabled: true, breakGlassUsernames: ['admin'] }, adminId);
    expect(view).toMatchObject({ enabled: true, ssoProviders: [{ kind: 'saml' }] });
    await detailRoute.PUT(req('PUT', `/api/v1/saml-providers/${created.id}`, { enabled: false }), params(created.id));
    expect(await listEnabledSsoProviders(ctx.db)).toEqual([]);
  });

  it('lets SCIM choose a SAML provider for sign-in, and only an existing one', async () => {
    await installLicense(ctx.db, 'enterprise');
    const created = await create();
    const view = await updateScimSettings({ providerId: `saml:${created.id}` }, adminId);
    expect(view.providerId).toBe(`saml:${created.id}`);
    expect(view.providers).toContainEqual(expect.objectContaining({ id: `saml:${created.id}`, name: 'Corp IdP (SAML)' }));
    await expect(updateScimSettings({ providerId: 'saml:999' }, adminId)).rejects.toThrow(/Unknown/);
  });
});

describe('SESSION_SECRET rotation', () => {
  it('re-encrypts the SP signing key', async () => {
    vi.resetModules();
    const OLD = 'old-operator-secret-abcdefghijklmnopqrstuvwxyz';
    const NEW = 'new-operator-secret-zyxwvutsrqponmlkjihgfedcba';
    vi.doMock('../../src/lib/config', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../src/lib/config')>()),
      config: (ctx.config = { sessionSecret: OLD, previousSessionSecrets: [] }),
    }));
    const secret = await import('../../src/lib/secret');
    const { reencryptStoredSecrets } = await import('../../src/lib/secret-rotation');
    const stored = secret.encryptSecret('sp-key-material');
    await ctx.db.insert(schema.samlProviders).values({
      name: 'Rotating', idpEntityId: IDP_ENTITY_ID, idpSsoUrl: IDP_SSO_URL, idpCertificates: '[]', spPrivateKey: stored,
      createdAt: now(), updatedAt: now(),
    });

    ctx.config!.sessionSecret = NEW;
    ctx.config!.previousSessionSecrets = [OLD];
    expect(await reencryptStoredSecrets()).toMatchObject({ failed: 0 });
    ctx.config!.previousSessionSecrets = [];
    const row = (await first(ctx.db.select().from(schema.samlProviders).limit(1)))!;
    expect(row.spPrivateKey).not.toBe(stored);
    expect(secret.reencryptSecret(row.spPrivateKey!)).toBeNull();
    expect(secret.decryptSecret(row.spPrivateKey!)).toBe('sp-key-material');
    vi.doUnmock('../../src/lib/config');
    vi.resetModules();
  });
});
