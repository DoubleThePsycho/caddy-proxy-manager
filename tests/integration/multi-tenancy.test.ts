/**
 * Multi-tenancy (ee/multi-tenancy) beyond the isolation matrix: the license
 * gate, organisations' life cycle (limits, disabling, deleting), moving rows,
 * the host fields organisation users cannot set (refused in the model), domain
 * uniqueness across organisations (certificate PEM names included), forward
 * auth across organisations, audit attribution, roles and escalation,
 * configuration import and restore, the database triggers, and installs
 * without organisations.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import forge from 'node-forge';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { apiRequest, idParams, json, nowIso } from '../helpers/custom-roles';
import { installLicense, licenseSigner } from '../helpers/config-fixture';
import {
  A_ADMIN,
  A_USER,
  B_ADMIN,
  B_USER,
  ORG_A,
  ORG_B,
  PROVIDER_ADMIN,
  PROVIDER_USER,
  insertOrganization,
  insertTenantUser,
  seedTenants,
  type TenantRows,
  type TenantTokens,
} from '../helpers/multi-tenancy';

const ctx = vi.hoisted(() => {
  // Vite exposes BASE_URL="/" to tests; the portal routes need an absolute origin.
  process.env.BASE_URL = 'http://localhost:3000';
  return { db: null as unknown as TestDb, sessionUserId: 0 };
});

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('@/src/lib/auth', async (importOriginal) => importOriginal());
// The real audit log: attribution is part of what is tested.
vi.mock('@/src/lib/audit', async (importOriginal) => importOriginal());
vi.mock('@/src/lib/auth-server', () => ({
  getAuth: () => ({
    api: { getSession: async () => ({ user: { id: ctx.sessionUserId }, session: { id: 1, createdAt: new Date() } }) },
  }),
  reloadOAuthProviders: async () => {},
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, set: () => {} }) }));
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../../src/lib/caddy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/caddy')>()),
  applyCaddyConfig: vi.fn(async () => undefined),
}));

import { setTrustedLicenseKeysForTests } from '@/ee/licensing/public-keys';
import { createProxyHost, getProxyHost, updateProxyHost } from '@/src/lib/models/proxy-hosts';
import { createCertificate } from '@/src/lib/models/certificates';
import { checkHostAccess, createRedirectIntent } from '@/src/lib/models/forward-auth';
import { getGroupsForUser } from '@/src/lib/models/groups';
import { validateToken } from '@/src/lib/models/api-tokens';
import { auth } from '@/src/lib/auth';
import { logAuditEvent } from '@/src/lib/audit';
import { readConfigContent, writeConfigContent } from '@/src/lib/config-content';
import { accessForUser } from '@/ee/custom-roles/access';
import { getHostApprovalContext } from '@/ee/approvals/requests';
import { syncUserRole } from '@/ee/scim/role-sync';
import * as organizationsRoute from '@/app/api/v1/organizations/route';
import * as organizationRoute from '@/app/api/v1/organizations/[id]/route';
import * as membersRoute from '@/app/api/v1/organizations/[id]/members/route';
import * as moveRoute from '@/app/api/v1/organizations/move/route';
import * as hostsRoute from '@/app/api/v1/proxy-hosts/route';
import * as usersRoute from '@/app/api/v1/users/route';
import * as userRoute from '@/app/api/v1/users/[id]/route';
import * as certsRoute from '@/app/api/v1/certificates/route';
import * as portalSessionRoute from '@/app/api/forward-auth/session-login/route';
import { first as dbFirst } from '@/src/lib/db/ops';

let tokens: TenantTokens;
let rows: TenantRows;

beforeEach(async () => {
  ctx.db = createTestDb();
  ctx.sessionUserId = PROVIDER_ADMIN;
  setTrustedLicenseKeysForTests(licenseSigner.keys);
  await installLicense(ctx.db, 'msp');
  ({ tokens, rows } = await seedTenants(ctx.db));
});

afterAll(() => setTrustedLicenseKeysForTests(null));

async function removeLicense() {
  await ctx.db.delete(schema.settings).where(eq(schema.settings.key, 'license'));
}

async function user(id: number) {
  return (await dbFirst(ctx.db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1)))!;
}

function selfSignedPem(names: string[]): string {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date('2026-01-01T00:00:00Z');
  cert.validity.notAfter = new Date('2027-01-01T00:00:00Z');
  cert.setSubject([{ name: 'commonName', value: names[0] }]);
  cert.setIssuer([{ name: 'commonName', value: names[0] }]);
  cert.setExtensions([{ name: 'subjectAltName', altNames: names.map((value) => ({ type: 2, value })) }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}

const newHost = (extra: Record<string, unknown> = {}) => ({
  name: 'New', domains: ['new.alpha.example.com'], upstreams: ['app.alpha.example.com:8080'], ...extra,
});

describe('license gate', () => {
  it('needs the license to create, change and enable organisations and to move rows in', async () => {
    await removeLicense();
    const provider = (method: string, payload?: unknown) => apiRequest(method, '/x', tokens.provider, payload);
    expect((await organizationsRoute.POST(provider('POST', { name: 'Charlie' }))).status).toBe(403);
    expect((await organizationRoute.PATCH(provider('PATCH', { name: 'Alpha 2' }), idParams(ORG_A))).status).toBe(403);
    expect((await moveRoute.POST(provider('POST', { organizationId: ORG_A, proxyHostIds: [rows.hosts.p] }))).status).toBe(403);
    expect((await membersRoute.POST(provider('POST', { userIds: [PROVIDER_USER] }), idParams(ORG_A))).status).toBe(403);
    expect((await hostsRoute.POST(provider('POST', newHost({ organizationId: ORG_A })))).status).toBe(403);
    expect((await usersRoute.POST(provider('POST', { email: 'x@alpha.example.com', password: 'Correct-Horse-9!x', organizationId: ORG_A }))).status).toBe(403);

    // Disabling, moving out and deleting never need it.
    const disabled = await organizationRoute.PATCH(provider('PATCH', { enabled: false }), idParams(ORG_A));
    expect(disabled.status).toBe(200);
    expect((await json(disabled)).enabled).toBe(false);
    expect((await organizationRoute.PATCH(provider('PATCH', { enabled: true }), idParams(ORG_A))).status).toBe(403);
    const out = await moveRoute.POST(provider('POST', { organizationId: null, proxyHostIds: [rows.hosts.b], certificateIds: [rows.certs.b], accessListIds: [rows.lists.b] }));
    expect(out.status).toBe(200);
    expect((await dbFirst(ctx.db.select().from(schema.proxyHosts).where(eq(schema.proxyHosts.id, rows.hosts.b)).limit(1)))!.organizationId).toBeNull();

    // The runtime never checks it: organisation users keep working in their organisation.
    const created = await hostsRoute.POST(apiRequest('POST', '/x', tokens.bAdmin, { name: 'B two', domains: ['two.bravo.example.com'], upstreams: ['b.example.org:80'] }));
    expect(created.status).toBe(201);
    expect((await json(created)).organizationId).toBe(ORG_B);
  });

  it('creates organisations with the license', async () => {
    const created = await organizationsRoute.POST(apiRequest('POST', '/x', tokens.provider, { name: 'Charlie Corp', maxProxyHosts: 1, allowedUpstreams: ['*.charlie.example.com'] }));
    expect(created.status).toBe(201);
    const organization = await json(created);
    expect(organization).toMatchObject({ slug: 'charlie-corp', enabled: true, maxProxyHosts: 1, allowedUpstreams: ['*.charlie.example.com'] });
    expect((await organizationsRoute.POST(apiRequest('POST', '/x', tokens.provider, { name: 'Again', slug: 'charlie-corp' }))).status).toBe(409);
    expect((await organizationsRoute.POST(apiRequest('POST', '/x', tokens.provider, { name: 'Bad', allowedUpstreams: ['http://x'] }))).status).toBe(400);
    expect((await organizationsRoute.POST(apiRequest('POST', '/x', tokens.provider, { name: 'Bad', owner: 1 }))).status).toBe(400);
    const list = await json(await organizationsRoute.GET(apiRequest('GET', '/x', tokens.provider)));
    expect(list.map((entry: { name: string }) => entry.name)).toEqual(['Alpha', 'BRAVO', 'Charlie Corp']);
    expect(list[0].counts).toEqual({ proxyHosts: 1, certificates: 1, accessLists: 1, groups: 1, users: 3 });
  });
});

describe('organisation life cycle', () => {
  it('refuses deleting an organisation that owns rows', async () => {
    const refused = await organizationRoute.DELETE(apiRequest('DELETE', '/x', tokens.provider), idParams(ORG_A));
    expect(refused.status).toBe(409);
    expect((await json(refused)).error).toMatch(/proxy host/);
    await insertOrganization(ctx.db, 9, 'Empty');
    await removeLicense();
    expect((await organizationRoute.DELETE(apiRequest('DELETE', '/x', tokens.provider), idParams(9))).status).toBe(204);
    expect(await dbFirst(ctx.db.select().from(schema.organizations).where(eq(schema.organizations.id, 9)).limit(1))).toBeUndefined();
  });

  it('keeps an organisation to its limits', async () => {
    await ctx.db.update(schema.organizations).set({ maxProxyHosts: 1, maxUsers: 3 }).where(eq(schema.organizations.id, ORG_A));
    const host = await hostsRoute.POST(apiRequest('POST', '/x', tokens.aAdmin, newHost()));
    expect(host.status).toBe(403);
    expect((await json(host)).error).toMatch(/limit of 1 proxy hosts/);
    const member = await usersRoute.POST(apiRequest('POST', '/x', tokens.aAdmin, { email: 'four@alpha.example.com', password: 'Correct-Horse-9!x' }));
    expect(member.status).toBe(403);
    const move = await moveRoute.POST(apiRequest('POST', '/x', tokens.provider, { organizationId: ORG_A, userIds: [PROVIDER_USER] }));
    expect(move.status).toBe(403);
  });

  it('locks a disabled organisation out without touching its hosts', async () => {
    await ctx.db.insert(schema.sessions).values({ userId: A_USER, token: 'alpha-session', expiresAt: '2099-01-01T00:00:00.000Z', createdAt: nowIso(), updatedAt: nowIso() });
    expect(await validateToken(tokens.aAdmin)).not.toBeNull();
    expect(await checkHostAccess(A_USER, rows.hosts.a)).toBe(true);

    const response = await organizationRoute.PATCH(apiRequest('PATCH', '/x', tokens.provider, { enabled: false }), idParams(ORG_A));
    expect(response.status).toBe(200);
    expect(await ctx.db.select().from(schema.sessions).where(eq(schema.sessions.userId, A_USER))).toEqual([]);
    expect(await ctx.db.select().from(schema.forwardAuthSessions).where(eq(schema.forwardAuthSessions.userId, A_USER))).toEqual([]);
    expect(await validateToken(tokens.aAdmin)).toBeNull();
    expect(await checkHostAccess(A_USER, rows.hosts.a)).toBe(false);
    ctx.sessionUserId = A_ADMIN;
    expect(await auth()).toBeNull();
    // Its users hold nothing; its hosts keep serving.
    expect((await accessForUser({ id: A_ADMIN, role: 'org_admin', customRoleId: null })).permissions.size).toBe(0);
    expect((await getProxyHost(rows.hosts.a))!.enabled).toBe(true);
    // BRAVO is untouched.
    ctx.sessionUserId = B_ADMIN;
    expect(await auth()).not.toBeNull();
  });
});

describe('moving rows', () => {
  const move = (payload: unknown) => moveRoute.POST(apiRequest('POST', '/x', tokens.provider, payload));

  it('keeps a host with its certificate and access list', async () => {
    const refused = await move({ organizationId: ORG_A, proxyHostIds: [rows.hosts.p] });
    expect(refused.status).toBe(409);
    expect((await json(refused)).error).toMatch(/certificate/);
    expect((await getProxyHost(rows.hosts.p))!.organizationId).toBeNull();
    // Leaving a host behind without its certificate is refused the other way round too.
    expect((await move({ organizationId: ORG_A, certificateIds: [rows.certs.p] })).status).toBe(409);
    const moved = await move({ organizationId: ORG_A, proxyHostIds: [rows.hosts.p], certificateIds: [rows.certs.p] });
    expect(moved.status).toBe(200);
    expect(await json(moved)).toMatchObject({ organizationId: ORG_A, proxyHostIds: 1, certificateIds: 1 });
    expect((await getProxyHost(rows.hosts.p))!.organizationId).toBe(ORG_A);
  });

  it('gives moved users a role that fits and never provider access by accident', async () => {
    await insertTenantUser(ctx.db, 20, 'admin', null, null, 'second-admin');
    expect((await move({ organizationId: ORG_A, userIds: [20] })).status).toBe(200);
    expect(await user(20)).toMatchObject({ organizationId: ORG_A, role: 'org_admin' });
    expect((await move({ organizationId: null, userIds: [20, A_ADMIN] })).status).toBe(200);
    expect(await user(20)).toMatchObject({ organizationId: null, role: 'viewer' });
    expect(await user(A_ADMIN)).toMatchObject({ organizationId: null, role: 'viewer' });
    expect((await move({ organizationId: ORG_A, userIds: [PROVIDER_ADMIN] })).status).toBe(400);
  });

  it('refuses moving your own account and the last active administrator', async () => {
    expect((await moveRoute.POST(apiRequest('POST', '/x', tokens.provider, { organizationId: ORG_A, userIds: [PROVIDER_ADMIN] }))).status).toBe(400);
    // A provider-level role holding organizations:write, and one active administrator left.
    const { insertRole, insertToken } = await import('../helpers/custom-roles');
    await insertRole(ctx.db, 5, ['organizations:read', 'organizations:write'], [], 'Tenancy');
    await insertTenantUser(ctx.db, 20, 'viewer', null, 5, 'tenancy-operator');
    await insertTenantUser(ctx.db, 21, 'admin', null, null, 'second-admin');
    await ctx.db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, PROVIDER_ADMIN));
    const operator = await insertToken(ctx.db, 20);
    const response = await moveRoute.POST(apiRequest('POST', '/x', operator, { organizationId: ORG_A, userIds: [21] }));
    expect(response.status).toBe(400);
    expect((await json(response)).error).toMatch(/no active administrator/);
    expect(await user(21)).toMatchObject({ role: 'admin', organizationId: null });
  });

  it('removes access that would cross organisations', async () => {
    const now = nowIso();
    // A provider user granted on a provider host, member of a provider group, moves into ALPHA.
    await ctx.db.insert(schema.forwardAuthAccess).values({ proxyHostId: rows.hosts.p, userId: PROVIDER_USER, createdAt: now });
    const response = await move({ organizationId: ORG_A, userIds: [PROVIDER_USER] });
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ userIds: 1, removedGrants: 1, removedMemberships: 1 });
    expect(await ctx.db.select().from(schema.groupMembers).where(eq(schema.groupMembers.userId, PROVIDER_USER))).toEqual([]);
    // A moved group loses members and grants of other organisations.
    const out = await move({ organizationId: ORG_B, groupIds: [rows.groups.a] });
    expect(out.status).toBe(200);
    expect(await json(out)).toMatchObject({ groupIds: 1, removedGrants: 1, removedMemberships: 1 });
  });

  it('refuses a move that would serve one domain in two organisations', async () => {
    const t = nowIso();
    await ctx.db.insert(schema.proxyHosts).values({
      name: 'Shadow', domains: '["app.bravo.example.com"]', upstreams: '["x:80"]', organizationId: null, createdAt: t, updatedAt: t,
    });
    const shadow = (await dbFirst(ctx.db.select().from(schema.proxyHosts).where(eq(schema.proxyHosts.name, 'Shadow')).limit(1)))!.id;
    const response = await move({ organizationId: ORG_A, proxyHostIds: [shadow] });
    expect(response.status).toBe(409);
    expect((await json(response)).error).toMatch(/already in use/);
  });

  it('records the move in both organisations without naming the other', async () => {
    expect((await move({ organizationId: ORG_A, accessListIds: [rows.lists.p] })).status).toBe(200);
    const events = await ctx.db.select().from(schema.auditEvents);
    const into = events.find((event) => event.action === 'organization_move_in')!;
    const out = events.find((event) => event.action === 'organization_move_out')!;
    expect(into).toMatchObject({ organizationId: ORG_A });
    expect(out).toMatchObject({ organizationId: null });
    expect(into.summary).toMatch(/into organisation Alpha/);
  });
});

describe('host fields organisation users cannot set (model layer)', () => {
  const refusals: Array<[string, Record<string, unknown>, RegExp]> = [
    ['custom reverse-proxy JSON', { customReverseProxyJson: '{"handler":"static_response"}' }, /custom Caddy JSON/],
    ['custom pre-handlers JSON', { customPreHandlersJson: '[{"handler":"vars"}]' }, /custom Caddy JSON/],
    ['raw WAF directives', { waf: { enabled: true, mode: 'On', custom_directives: 'SecRuleEngine Off' } }, /WAF directives/],
    ['mTLS', { mtls: { enabled: true, trusted_client_cert_ids: [1] } }, /mTLS/],
    ['DNS resolvers', { dnsResolver: { enabled: true, resolvers: ['198.51.100.53'] } }, /DNS resolvers/],
    ['an upstream outside the list', { upstreams: ['internal.example.net:80'] }, /allowed upstreams/],
    ['a location-rule upstream outside the list', { locationRules: [{ path: '/api/*', upstreams: ['10.2.0.1:80'] }] }, /allowed upstreams/],
    ['a socket', { upstreams: ['unix//var/run/docker.sock'] }, /Unix socket/],
    ['a placeholder', { upstreams: ['{http.request.header.X-Target}:80'] }, /placeholders/],
    ['the admin API port', { upstreams: ['10.1.0.1:2019'] }, /2019/],
    ['a health check on the admin API port', { loadBalancer: { enabled: true, activeHealthCheck: { enabled: true, uri: '/', port: 2019 } } }, /2019/],
    ['an Authentik outpost elsewhere', { authentik: { enabled: true, outpostDomain: 'auth.example.net', outpostUpstream: 'http://10.9.0.1:9000' } }, /allowed upstreams/],
    ['a forward-auth server elsewhere', { forwardAuth: { enabled: true, provider: 'custom', authUpstream: 'http://10.9.0.1:9091' } }, /allowed upstreams/],
  ];

  it.each(refusals)('refuses %s on create and update, whatever the path', async (_name, fields, message) => {
    await expect(createProxyHost({ ...newHost(), ...fields } as never, A_ADMIN)).rejects.toThrow(message);
    await expect(updateProxyHost(rows.hosts.a, fields as never, A_ADMIN)).rejects.toThrow(message);
    const response = await hostsRoute.POST(apiRequest('POST', '/x', tokens.aAdmin, newHost(fields)));
    expect(response.status).toBe(403);
  });

  it('lets the provider set them on an organisation host, and the organisation keep them', async () => {
    const fields = { customReverseProxyJson: '{"headers":{}}', upstreams: ['internal.example.net:80'] };
    await updateProxyHost(rows.hosts.a, fields, PROVIDER_ADMIN);
    // ALPHA edits other fields; the provider's values stay.
    const updated = await updateProxyHost(rows.hosts.a, { name: 'Renamed', ...fields }, A_ADMIN);
    expect(updated.customReverseProxyJson).toBe('{"headers":{}}');
    // Clearing is not setting.
    const cleared = await updateProxyHost(rows.hosts.a, { customReverseProxyJson: null }, A_ADMIN);
    expect(cleared.customReverseProxyJson).toBeNull();
  });

  it('allows what the organisation\'s list allows', async () => {
    const host = await createProxyHost(newHost({ upstreams: ['10.1.4.4:80', 'https://x.alpha.example.com'] }) as never, A_ADMIN);
    expect(host.organizationId).toBe(ORG_A);
  });
});

describe('domains across organisations', () => {
  it('refuses a domain another organisation serves or holds a certificate for', async () => {
    await expect(createProxyHost(newHost({ domains: ['app.bravo.example.com'] }) as never, A_ADMIN)).rejects.toThrow(/already in use/);
    await expect(createCertificate({ name: 'Grab', type: 'managed', domainNames: ['*.bravo.example.com'] }, A_ADMIN)).rejects.toThrow(/already in use/);
    await expect(createCertificate({ name: 'Grab', type: 'managed', domainNames: ['app.provider.example.com'] }, A_ADMIN)).rejects.toThrow(/already in use/);
    // The provider level counts as one tenant too, both ways.
    await expect(createProxyHost({ name: 'P', domains: ['app.alpha.example.com'], upstreams: ['x:80'] }, PROVIDER_ADMIN)).rejects.toThrow(/already in use/);
    // Inside one organisation it is that organisation's business.
    const twin = await createProxyHost(newHost({ domains: ['app.alpha.example.com'] }) as never, A_ADMIN);
    expect(twin.organizationId).toBe(ORG_A);
  });

  it('checks the names in an imported certificate, not only the ones stated', async () => {
    const pem = selfSignedPem(['ok.alpha.example.com', 'app.bravo.example.com']);
    const response = await certsRoute.POST(apiRequest('POST', '/x', tokens.aAdmin, {
      name: 'Sneaky', type: 'imported', domainNames: ['ok.alpha.example.com'], certificatePem: pem, privateKeyPem: 'key',
    }));
    expect(response.status).toBe(409);
    expect((await json(response)).error).toMatch(/app\.bravo\.example\.com/);
  });
});

describe('forward auth across organisations', () => {
  it('never lets a user through to another organisation\'s host, whatever the grants say', async () => {
    const now = nowIso();
    // Grants that the API would refuse, written directly.
    await ctx.db.insert(schema.forwardAuthAccess).values({ proxyHostId: rows.hosts.b, userId: A_USER, createdAt: now });
    await ctx.db.insert(schema.forwardAuthAccess).values({ proxyHostId: rows.hosts.b, groupId: rows.groups.a, createdAt: now });
    await ctx.db.insert(schema.forwardAuthAccess).values({ proxyHostId: rows.hosts.a, userId: PROVIDER_USER, createdAt: now });
    expect(await checkHostAccess(A_USER, rows.hosts.a)).toBe(true);
    expect(await checkHostAccess(A_USER, rows.hosts.b)).toBe(false);
    expect(await checkHostAccess(B_USER, rows.hosts.b)).toBe(true);
    expect(await checkHostAccess(B_USER, rows.hosts.a)).toBe(false);
    expect(await checkHostAccess(PROVIDER_USER, rows.hosts.a)).toBe(false);
    expect(await checkHostAccess(PROVIDER_USER, rows.hosts.p)).toBe(true);
  });

  it('refuses a portal sign-in of an ALPHA user to a BRAVO host', async () => {
    const portalHost = await createProxyHost(
      { name: 'BRAVO portal app', domains: ['portal.bravo.example.com'], upstreams: ['10.9.0.1:80'], ingressiForwardAuth: { enabled: true } },
      B_ADMIN
    );
    const now = nowIso();
    // ALPHA's user is even granted directly (a grant the API would refuse).
    await ctx.db.insert(schema.forwardAuthAccess).values({ proxyHostId: portalHost.id, userId: A_USER, createdAt: now });
    await ctx.db.insert(schema.forwardAuthAccess).values({ proxyHostId: portalHost.id, userId: B_USER, createdAt: now });
    const signIn = async (userId: number) => {
      ctx.sessionUserId = userId;
      const rid = await createRedirectIntent('https://portal.bravo.example.com/');
      return portalSessionRoute.POST({ headers: new Headers({ origin: 'http://localhost:3000' }), json: async () => ({ rid }) } as never);
    };
    const refused = await signIn(A_USER);
    expect(refused.status).toBe(403);
    expect(await ctx.db.select().from(schema.forwardAuthSessions).where(eq(schema.forwardAuthSessions.proxyHostId, portalHost.id))).toEqual([]);
    const allowed = await signIn(B_USER);
    expect(allowed.status).toBe(200);
    expect((await json(allowed)).redirectTo).toMatch(/^https:\/\/portal\.bravo\.example\.com\//);
  });

  it('sends only the user\'s own organisation\'s groups', async () => {
    await ctx.db.insert(schema.groupMembers).values({ groupId: rows.groups.b, userId: A_USER, createdAt: nowIso() });
    expect((await getGroupsForUser(A_USER)).map((group) => group.name)).toEqual(['Alpha staff']);
  });
});

describe('roles and escalation', () => {
  it('keeps admin and org_admin apart', async () => {
    const provider = (method: string, payload: unknown) => apiRequest(method, '/x', tokens.provider, payload);
    expect((await userRoute.PUT(provider('PUT', { role: 'admin' }), idParams(A_USER))).status).toBe(400);
    expect((await userRoute.PUT(provider('PUT', { role: 'org_admin' }), idParams(PROVIDER_USER))).status).toBe(400);
    expect((await userRoute.PUT(provider('PUT', { role: 'org_admin' }), idParams(A_USER))).status).toBe(200);
    expect((await user(A_USER)).role).toBe('org_admin');
    // ALPHA's administrator manages ALPHA's roles with the organisation roles only.
    expect((await userRoute.PUT(apiRequest('PUT', '/x', tokens.aAdmin, { role: 'user' }), idParams(A_USER))).status).toBe(200);
    expect((await userRoute.PUT(apiRequest('PUT', '/x', tokens.aAdmin, { customRoleId: 1 }), idParams(A_USER))).status).toBe(403);
  });

  it('refuses custom roles with provider permissions for organisation users', async () => {
    const response = await userRoute.PUT(apiRequest('PUT', '/x', tokens.provider, { customRoleId: 1 }), idParams(A_USER));
    expect(response.status).toBe(400);
    expect((await json(response)).error).toMatch(/organisation users cannot have/);
  });

  it('cuts a forced custom role down to the organisation permissions', async () => {
    const access = await accessForUser({ id: 6, role: 'viewer', customRoleId: 1 });
    expect(access.isAdmin).toBe(false);
    expect(access.organizationId).toBe(ORG_A);
    expect(access.permissions.has('settings:write')).toBe(false);
    expect(access.permissions.has('proxy_hosts:write')).toBe(true);
  });

  it('never takes an organisation from an identity provider\'s claims', async () => {
    const { enforceSafeUserDefaults, withoutOrganization } = await vi.importActual<typeof import('@/src/lib/auth-server')>('@/src/lib/auth-server');
    expect(withoutOrganization({ email: 'x@example.com', organizationId: 2 })).toEqual({ email: 'x@example.com' });
    expect(enforceSafeUserDefaults({ email: 'x@example.com', organizationId: 2, role: 'org_admin' })).toEqual({ email: 'x@example.com', role: 'user', status: 'active' });
  });

  it('leaves organisation users\' roles to their organisation in SCIM', async () => {
    await ctx.db.insert(schema.scimUsers).values({ userId: A_USER, userName: 'alpha-user', userNameKey: 'alpha-user', active: true, createdAt: nowIso(), updatedAt: nowIso() });
    const event = await syncUserRole(ctx.db as never, A_USER, { manageRoles: true, defaultRole: 'admin' } as never);
    expect(event).toBeNull();
    expect((await user(A_USER)).role).toBe('user');
  });

  it('hides approval policies from organisation users', async () => {
    expect(await getHostApprovalContext(await accessForUser({ id: A_ADMIN, role: 'org_admin', customRoleId: null }))).toEqual({ policies: [], canEmergency: false });
  });
});

describe('audit attribution', () => {
  it('files an event under the organisation of its row, or of the user acting', async () => {
    await logAuditEvent({ userId: PROVIDER_ADMIN, action: 'update', entityType: 'proxy_host', entityId: rows.hosts.a, summary: 'about alpha host' });
    await logAuditEvent({ userId: A_ADMIN, action: 'login', entityType: 'session', summary: 'alpha login' });
    await logAuditEvent({ userId: PROVIDER_ADMIN, action: 'update', entityType: 'setting', summary: 'provider setting' });
    await logAuditEvent({ userId: PROVIDER_ADMIN, action: 'update', entityType: 'user', entityId: B_USER, summary: 'about bravo user' });
    const bySummary = async (summary: string) =>
      (await dbFirst(ctx.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.summary, summary)).limit(1)))!.organizationId;
    expect(await bySummary('about alpha host')).toBe(ORG_A);
    expect(await bySummary('alpha login')).toBe(ORG_A);
    expect(await bySummary('provider setting')).toBeNull();
    expect(await bySummary('about bravo user')).toBe(ORG_B);
  });
});

describe('configuration restore and import', () => {
  it('keeps organisations on a restore and drops them on an import', async () => {
    const content = await ctx.db.transaction(async (tx) => await readConfigContent(tx as never));
    expect(content.tables.proxyHosts.find((row) => row.id === rows.hosts.b)!.organizationId).toBe(ORG_B);
    await ctx.db.transaction(async (tx) => await writeConfigContent(tx as never, content, 'restore'));
    expect((await dbFirst(ctx.db.select().from(schema.proxyHosts).where(eq(schema.proxyHosts.id, rows.hosts.b)).limit(1)))!.organizationId).toBe(ORG_B);
    await ctx.db.transaction(async (tx) => await writeConfigContent(tx as never, content, 'import'));
    for (const table of [schema.proxyHosts, schema.certificates, schema.accessLists, schema.groups]) {
      expect((await ctx.db.select().from(table)).every((row) => row.organizationId === null)).toBe(true);
    }
  });

  it('drops an organisation that no longer exists on a restore', async () => {
    const content = await ctx.db.transaction(async (tx) => await readConfigContent(tx as never));
    await ctx.db.delete(schema.organizations).where(eq(schema.organizations.id, ORG_B));
    await ctx.db.transaction(async (tx) => await writeConfigContent(tx as never, content, 'restore'));
    expect((await dbFirst(ctx.db.select().from(schema.proxyHosts).where(eq(schema.proxyHosts.id, rows.hosts.b)).limit(1)))!.organizationId).toBeNull();
  });
});

describe('database guards', () => {
  it('refuses an administrator in an organisation and an organisation administrator outside one', async () => {
    await expect(ctx.db.update(schema.users).set({ role: 'admin' }).where(eq(schema.users.id, A_USER))).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/organization role mismatch/) }) });
    await expect(ctx.db.update(schema.users).set({ organizationId: ORG_A }).where(eq(schema.users.id, PROVIDER_ADMIN))).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/organization role mismatch/) }) });
    await expect(ctx.db.update(schema.users).set({ organizationId: null }).where(eq(schema.users.id, A_ADMIN))).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/organization role mismatch/) }) });
    await expect(insertTenantUser(ctx.db, 30, 'org_admin', null)).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/organization role mismatch/) }) });
    expect((await user(A_USER)).role).toBe('user');
  });
});

describe('installs without organisations', () => {
  it('behave exactly as before', async () => {
    const db = createTestDb();
    ctx.db = db;
    await insertTenantUser(db, 1, 'admin', null);
    const first = await createProxyHost({ name: 'One', domains: ['same.example.com'], upstreams: ['x:80'] }, 1);
    const second = await createProxyHost({ name: 'Two', domains: ['same.example.com'], upstreams: ['10.0.0.1:2019'] }, 1);
    expect([first.organizationId, second.organizationId]).toEqual([null, null]);
    expect(await checkHostAccess(1, first.id)).toBe(false);
    await db.insert(schema.forwardAuthAccess).values({ proxyHostId: first.id, userId: 1, createdAt: nowIso() });
    expect(await checkHostAccess(1, first.id)).toBe(true);
    await logAuditEvent({ userId: 1, action: 'x', entityType: 'proxy_host', entityId: first.id, summary: 'plain' });
    expect((await dbFirst(db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.summary, 'plain'))).limit(1)))!.organizationId).toBeNull();
  });
});
