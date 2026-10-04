/**
 * SCIM administration (/api/v1/scim/*) and the SSO linking of SCIM users:
 *
 *  - license gate (Enterprise "scim"): turning on, changing settings,
 *    creating tokens, adding or changing mappings and handing users or groups
 *    to SCIM are refused without it; reading, turning off, revoking,
 *    deleting mappings and releasing never need it;
 *  - tokens are shown once and stored hashed;
 *  - mappings are role grants (escalation guards) and only on SCIM groups;
 *  - handing over: the only way a local account becomes visible to SCIM;
 *    protected accounts are refused;
 *  - linking the first SSO sign-in: only the SCIM sign-in provider, only
 *    active SCIM users, never local accounts, never twice, with the
 *    email_verified / externalId-claim checks; wired into Better Auth's
 *    mapProfileToUser;
 *  - permissions: scim:write is administrator-level.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { installLicense, licenseSigner } from '../helpers/config-fixture';
import { body, entraUser, idParams, insertLocalUser, insertScimToken, now, scimRequest, setScimSettings } from '../helpers/scim';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

vi.mock('../../src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-auth')>();
  return { ...actual, requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))), requireApiAdmin: vi.fn() };
});

import { requireApiAdmin } from '../../src/lib/api-auth';
import { logAuditEvent } from '../../src/lib/audit';
import { setTrustedLicenseKeysForTests } from '../../ee/licensing/public-keys';
import { isAdminLevel, PERMISSION_AREAS, type Access } from '../../src/lib/permissions';
import { mapOAuthProvider } from '../../src/lib/auth-server';
import { canLinkScimSignIn, noteScimSignInLink } from '../../ee/scim/binding';
import { createRoleMapping } from '../../ee/scim/service';
import * as settingsRoute from '../../app/api/v1/scim/settings/route';
import * as tokensRoute from '../../app/api/v1/scim/tokens/route';
import * as tokenRoute from '../../app/api/v1/scim/tokens/[id]/route';
import * as mappingsRoute from '../../app/api/v1/scim/role-mappings/route';
import * as mappingRoute from '../../app/api/v1/scim/role-mappings/[id]/route';
import * as managedUsersRoute from '../../app/api/v1/scim/users/route';
import * as managedUserRoute from '../../app/api/v1/scim/users/[id]/route';
import * as managedGroupsRoute from '../../app/api/v1/scim/groups/route';
import * as managedGroupRoute from '../../app/api/v1/scim/groups/[id]/route';
import * as scimUsersRoute from '../../app/scim/v2/Users/route';
import * as scimUserRoute from '../../app/scim/v2/Users/[id]/route';
import { first } from '@/src/lib/db/ops';

const LICENSE_ERROR = 'SCIM provisioning needs an active Ingressi Enterprise license or higher';
const ADMIN_ID = 1;

function req(method: string, path: string, payload?: unknown): NextRequest {
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers: {} };
  if (payload !== undefined) {
    init.body = JSON.stringify(payload);
    init.headers['content-type'] = 'application/json';
  }
  return new NextRequest(`http://localhost${path}`, init);
}

async function removeLicense() {
  await ctx.db.delete(schema.settings).where(eq(schema.settings.key, 'license'));
}

async function insertProvider(id: string, autoLink = false) {
  await ctx.db.insert(schema.oauthProviders).values({
    id, name: `IdP ${id}`, type: 'oidc', clientId: 'cid', clientSecret: 'secret', issuer: 'https://idp.example.com',
    scopes: 'openid email profile', autoLink, enabled: true, source: 'ui', createdAt: now(), updatedAt: now(),
  });
}

async function insertScimGroup(name: string): Promise<number> {
  const group = (await first(ctx.db.insert(schema.groups).values({ name, createdAt: now(), updatedAt: now() }).returning()))!;
  await ctx.db.insert(schema.scimGroups).values({ groupId: group.id, origin: 'scim', createdAt: now(), updatedAt: now() });
  return group.id;
}

beforeEach(async () => {
  ctx.db = createTestDb();
  vi.clearAllMocks();
  setTrustedLicenseKeysForTests(licenseSigner.keys);
  await insertLocalUser(ctx.db, { id: ADMIN_ID, email: 'admin@localhost', role: 'admin' });
  await installLicense(ctx.db, 'enterprise');
  vi.mocked(requireApiAdmin).mockResolvedValue({ userId: ADMIN_ID, role: 'admin', authMethod: 'bearer' });
});

afterAll(() => setTrustedLicenseKeysForTests(null));

describe('license gate', () => {
  it('refuses setting up and changing SCIM without a license', async () => {
    const group = await insertScimGroup('Eng');
    const local = await insertLocalUser(ctx.db, { email: 'local@example.com' });
    const localGroup = (await first(ctx.db.insert(schema.groups).values({ name: 'Local', createdAt: now(), updatedAt: now() }).returning()))!;
    const mapping = (await first(ctx.db.insert(schema.scimRoleMappings).values({ groupId: group, role: 'user', createdAt: now(), updatedAt: now() }).returning()))!;
    await removeLicense();
    const responses = [
      await settingsRoute.PUT(req('PUT', '/x', { enabled: true })),
      await settingsRoute.PUT(req('PUT', '/x', { deleteMode: 'delete' })),
      await tokensRoute.POST(req('POST', '/x', { name: 'Entra' })),
      await mappingsRoute.POST(req('POST', '/x', { groupId: group, role: 'viewer' })),
      await mappingRoute.PUT(req('PUT', '/x', { priority: 1 }), idParams(mapping.id)),
      await managedUsersRoute.POST(req('POST', '/x', { userId: local, userName: 'local@example.com' })),
      await managedGroupsRoute.POST(req('POST', '/x', { groupId: localGroup.id })),
    ];
    for (const response of responses) {
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe(LICENSE_ERROR);
    }
    expect(await ctx.db.select().from(schema.scimTokens)).toEqual([]);
  });

  it('refuses a Business license (Enterprise feature)', async () => {
    await installLicense(ctx.db, 'business');
    expect((await tokensRoute.POST(req('POST', '/x', { name: 'Entra' }))).status).toBe(403);
  });

  it('lets an unlicensed admin read, turn off, revoke, delete mappings and release', async () => {
    await setScimSettings(ctx.db, { enabled: true });
    const token = await insertScimToken(ctx.db);
    const group = await insertScimGroup('Eng');
    const mapping = (await first(ctx.db.insert(schema.scimRoleMappings).values({ groupId: group, role: 'user', createdAt: now(), updatedAt: now() }).returning()))!;
    const user = await insertLocalUser(ctx.db, { email: 'managed@example.com' });
    await ctx.db.insert(schema.scimUsers).values({ userId: user, userName: 'managed', userNameKey: 'managed', createdAt: now(), updatedAt: now() });
    await removeLicense();

    for (const response of [
      await settingsRoute.GET(req('GET', '/x')),
      await tokensRoute.GET(req('GET', '/x')),
      await mappingsRoute.GET(req('GET', '/x')),
      await managedUsersRoute.GET(req('GET', '/x')),
      await managedGroupsRoute.GET(req('GET', '/x')),
    ]) expect(response.status).toBe(200);

    const off = await settingsRoute.PUT(req('PUT', '/x', { enabled: false }));
    expect(off.status).toBe(200);
    expect((await off.json()).enabled).toBe(false);
    expect((await tokenRoute.DELETE(req('DELETE', '/x'), idParams(token.id))).status).toBe(204);
    expect((await mappingRoute.DELETE(req('DELETE', '/x'), idParams(mapping.id))).status).toBe(204);
    expect((await managedUserRoute.DELETE(req('DELETE', '/x'), idParams(user))).status).toBe(204);
    expect((await managedGroupRoute.DELETE(req('DELETE', '/x'), idParams(group))).status).toBe(204);
    expect(await ctx.db.select().from(schema.scimTokens)).toEqual([]);
    expect(await ctx.db.select().from(schema.scimUsers)).toEqual([]);
    expect(await ctx.db.select().from(schema.scimGroups)).toEqual([]);
  });
});

describe('settings', () => {
  it('saves settings, validates them and audits the change', async () => {
    await insertProvider('entra');
    const response = await settingsRoute.PUT(req('PUT', '/x', { enabled: true, providerId: 'entra', externalIdClaim: 'oid', deleteMode: 'delete' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: true, providerId: 'entra', externalIdClaim: 'oid', deleteMode: 'delete', configurable: true });
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(expect.objectContaining({ action: 'update', entityType: 'scim_settings', userId: ADMIN_ID }));

    for (const bad of [{ providerId: 'missing' }, { externalIdClaim: 'has space' }, { deleteMode: 'wipe' }, { defaultRole: 'admin' }, { surprise: 1 }]) {
      expect((await settingsRoute.PUT(req('PUT', '/x', bad))).status, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe('tokens', () => {
  it('shows the token once and stores only its hash', async () => {
    const response = await tokensRoute.POST(req('POST', '/x', { name: 'Okta' }));
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created.token).toMatch(/^scim_[A-Za-z0-9_-]{43}$/);
    const row = (await first(ctx.db.select().from(schema.scimTokens).limit(1)))!;
    expect(row.tokenHash).toBe(createHash('sha256').update(created.token).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(created.token);
    const listed = await (await tokensRoute.GET(req('GET', '/x'))).json();
    expect(JSON.stringify(listed)).not.toContain(created.token);
    expect(listed[0]).toMatchObject({ name: 'Okta', prefix: created.token.slice(0, 11) });
    // The created token works on the SCIM endpoint.
    await setScimSettings(ctx.db, { enabled: true });
    expect((await scimUsersRoute.GET(scimRequest('GET', '/scim/v2/Users', created.token))).status).toBe(200);
  });

  it('validates input', async () => {
    expect((await tokensRoute.POST(req('POST', '/x', {}))).status).toBe(400);
    expect((await tokensRoute.POST(req('POST', '/x', { name: 'x', expiresAt: '2001-01-01T00:00:00Z' }))).status).toBe(400);
    expect((await tokenRoute.DELETE(req('DELETE', '/x'), idParams(999))).status).toBe(404);
  });
});

describe('role mappings', () => {
  it('maps only groups SCIM manages, once per group', async () => {
    const local = (await first(ctx.db.insert(schema.groups).values({ name: 'Local', createdAt: now(), updatedAt: now() }).returning()))!;
    expect((await mappingsRoute.POST(req('POST', '/x', { groupId: local.id, role: 'admin' }))).status).toBe(400);
    const group = await insertScimGroup('Eng');
    const created = await mappingsRoute.POST(req('POST', '/x', { groupId: group, role: 'admin', priority: 5 }));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ groupId: group, groupName: 'Eng', role: 'admin', customRoleId: null, priority: 5 });
    expect((await mappingsRoute.POST(req('POST', '/x', { groupId: group, role: 'user' }))).status).toBe(409);
  });

  it('applies to SCIM users at once when roles are managed', async () => {
    await setScimSettings(ctx.db, { enabled: true, manageRoles: true });
    const group = await insertScimGroup('Eng');
    const user = await insertLocalUser(ctx.db, { email: 'scimuser@example.com' });
    await ctx.db.insert(schema.scimUsers).values({ userId: user, userName: 'scimuser', userNameKey: 'scimuser', createdAt: now(), updatedAt: now() });
    // The identity provider put the user in the group.
    await ctx.db.insert(schema.groupMembers).values({ groupId: group, userId: user, createdAt: now() });
    await ctx.db.insert(schema.scimGroupMembers).values({ groupId: group, userId: user, createdAt: now() });
    const response = await mappingsRoute.POST(req('POST', '/x', { groupId: group, role: 'admin' }));
    expect(response.status).toBe(201);
    expect((await first(ctx.db.select().from(schema.users).where(eq(schema.users.id, user)).limit(1)))?.role).toBe('admin');
    const { id } = await response.json();
    await mappingRoute.DELETE(req('DELETE', '/x'), idParams(id));
    expect((await first(ctx.db.select().from(schema.users).where(eq(schema.users.id, user)).limit(1)))?.role).toBe('user');
  });

  it('ignores memberships changed by hand on the Groups page', async () => {
    await setScimSettings(ctx.db, { enabled: true, manageRoles: true });
    const admins = await insertScimGroup('Admins');
    const viewers = await insertScimGroup('Viewers');
    const user = await insertLocalUser(ctx.db, { email: 'handmade@example.com' });
    await ctx.db.insert(schema.scimUsers).values({ userId: user, userName: 'handmade', userNameKey: 'handmade', createdAt: now(), updatedAt: now() });
    // The identity provider put the user in Viewers only.
    for (const groupId of [viewers]) {
      await ctx.db.insert(schema.groupMembers).values({ groupId, userId: user, createdAt: now() });
      await ctx.db.insert(schema.scimGroupMembers).values({ groupId, userId: user, createdAt: now() });
    }
    await mappingsRoute.POST(req('POST', '/x', { groupId: viewers, role: 'viewer', priority: 1 }));
    await mappingsRoute.POST(req('POST', '/x', { groupId: admins, role: 'admin', priority: 2 }));
    const role = async () => (await first(ctx.db.select().from(schema.users).where(eq(schema.users.id, user)).limit(1)))?.role;
    expect(await role()).toBe('viewer');

    // Someone with groups:write adds the user to Admins and removes them from Viewers by hand.
    const { addGroupMember, removeGroupMember } = await import('../../src/lib/models/groups');
    await addGroupMember(admins, user, ADMIN_ID);
    await removeGroupMember(viewers, user, ADMIN_ID);
    // Re-applying the mappings (any later SCIM change or mapping change) still gives viewer.
    await settingsRoute.PUT(req('PUT', '/x', { manageRoles: false }));
    await settingsRoute.PUT(req('PUT', '/x', { manageRoles: true }));
    expect(await role()).toBe('viewer');
  });

  it('refuses mapping a role the actor could not assign (escalation guard)', async () => {
    const group = await insertScimGroup('Eng');
    const actor: Access = {
      userId: 5, role: 'viewer', isAdmin: false, customRole: { id: 1, name: 'scim-ops' },
      permissions: new Set(['scim:read', 'scim:write', 'users:read', 'users:write']), scopeTags: [],
    };
    await expect(createRoleMapping(actor, { groupId: group, role: 'admin' })).rejects.toMatchObject({ status: 403 });
    await expect(createRoleMapping(actor, { groupId: group, role: 'viewer' })).resolves.toMatchObject({ role: 'viewer' });
  });
});

describe('handing accounts to SCIM', () => {
  it('makes a local account visible to SCIM only once handed over', async () => {
    await setScimSettings(ctx.db, { enabled: true });
    const token = await insertScimToken(ctx.db);
    const local = await insertLocalUser(ctx.db, { email: 'pat@example.com', name: 'Pat' });
    const find = async () => (await body(await scimUsersRoute.GET(scimRequest('GET', `/scim/v2/Users?filter=${encodeURIComponent('userName eq "Pat@Corp.example.com"')}`, token.raw)))).totalResults;
    expect(await find()).toBe(0);

    const response = await managedUsersRoute.POST(req('POST', '/x', { userId: local, userName: 'Pat@Corp.example.com', externalId: 'abc' }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ userId: local, userName: 'Pat@Corp.example.com', origin: 'adopted', externalId: 'abc' });
    expect(await find()).toBe(1);
    const patched = await scimUserRoute.PATCH(
      scimRequest('PATCH', `/scim/v2/Users/${local}`, token.raw, { Operations: [{ op: 'replace', path: 'displayName', value: 'Patricia' }] }),
      idParams(local)
    );
    expect(patched.status).toBe(200);
    expect((await first(ctx.db.select().from(schema.users).where(eq(schema.users.id, local)).limit(1)))?.name).toBe('Patricia');
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(expect.objectContaining({ action: 'scim_user_adopt', entityId: local }));
  });

  it('refuses the primary admin, break-glass accounts, duplicates and taken userNames', async () => {
    expect((await managedUsersRoute.POST(req('POST', '/x', { userId: ADMIN_ID, userName: 'admin' }))).status).toBe(400);
    const glass = await insertLocalUser(ctx.db, { email: 'glass@example.com', role: 'admin' });
    await ctx.db.insert(schema.settings).values({ key: 'sso_enforcement', value: JSON.stringify({ enabled: true, breakGlassUserIds: [glass] }), updatedAt: now() });
    expect((await managedUsersRoute.POST(req('POST', '/x', { userId: glass, userName: 'glass' }))).status).toBe(400);
    const a = await insertLocalUser(ctx.db, { email: 'a@example.com' });
    const b = await insertLocalUser(ctx.db, { email: 'b@example.com' });
    expect((await managedUsersRoute.POST(req('POST', '/x', { userId: a, userName: 'shared' }))).status).toBe(201);
    expect((await managedUsersRoute.POST(req('POST', '/x', { userId: a, userName: 'again' }))).status).toBe(409);
    expect((await managedUsersRoute.POST(req('POST', '/x', { userId: b, userName: 'SHARED' }))).status).toBe(409);
    expect((await managedUsersRoute.POST(req('POST', '/x', { userId: 999, userName: 'ghost' }))).status).toBe(404);
  });

  it('releasing leaves the account as it is', async () => {
    const local = await insertLocalUser(ctx.db, { email: 'rel@example.com' });
    await managedUsersRoute.POST(req('POST', '/x', { userId: local, userName: 'rel' }));
    expect((await managedUserRoute.DELETE(req('DELETE', '/x'), idParams(local))).status).toBe(204);
    expect((await first(ctx.db.select().from(schema.users).where(eq(schema.users.id, local)).limit(1)))?.status).toBe('active');
    expect((await managedUserRoute.DELETE(req('DELETE', '/x'), idParams(local))).status).toBe(404);
  });

  it('hands over groups once', async () => {
    const group = (await first(ctx.db.insert(schema.groups).values({ name: 'Ops', createdAt: now(), updatedAt: now() }).returning()))!;
    expect((await managedGroupsRoute.POST(req('POST', '/x', { groupId: group.id }))).status).toBe(201);
    expect((await managedGroupsRoute.POST(req('POST', '/x', { groupId: group.id }))).status).toBe(409);
    expect((await managedGroupsRoute.POST(req('POST', '/x', { groupId: 999 }))).status).toBe(404);
  });
});

describe('linking the first SSO sign-in', () => {
  async function provision(email: string, externalId = 'ext-1'): Promise<number> {
    await setScimSettings(ctx.db, { enabled: true, providerId: 'corp' });
    const token = await insertScimToken(ctx.db);
    const response = await scimUsersRoute.POST(scimRequest('POST', '/scim/v2/Users', token.raw, entraUser(email, { externalId })));
    return Number((await body(response)).id);
  }

  it('links a SCIM user through the SCIM provider when the address is verified', async () => {
    await insertProvider('corp');
    await provision('lin@example.com');
    expect(await canLinkScimSignIn('corp', { email: 'LIN@example.com', email_verified: true })).toBe(true);
    expect(await canLinkScimSignIn('corp', { email: 'lin@example.com', email_verified: 'true' })).toBe(true);
    expect(await canLinkScimSignIn('corp', { email: 'lin@example.com' })).toBe(false);
    expect(await canLinkScimSignIn('other', { email: 'lin@example.com', email_verified: true })).toBe(false);
  });

  it('never links a local account', async () => {
    await insertProvider('corp');
    await setScimSettings(ctx.db, { enabled: true, providerId: 'corp' });
    await insertLocalUser(ctx.db, { email: 'local@example.com', role: 'admin' });
    expect(await canLinkScimSignIn('corp', { email: 'local@example.com', email_verified: true })).toBe(false);
    expect(await canLinkScimSignIn('corp', { email: 'admin@localhost', email_verified: true })).toBe(false);
  });

  it('with an externalId claim, needs the claim to match exactly instead of email_verified', async () => {
    await insertProvider('corp');
    await provision('ext@example.com', '00u-OKTA-1');
    await setScimSettings(ctx.db, { enabled: true, providerId: 'corp', externalIdClaim: 'sub' });
    expect(await canLinkScimSignIn('corp', { email: 'ext@example.com', sub: '00u-OKTA-1' })).toBe(true);
    expect(await canLinkScimSignIn('corp', { email: 'ext@example.com', sub: '00u-okta-1', email_verified: true })).toBe(false);
    expect(await canLinkScimSignIn('corp', { email: 'ext@example.com', email_verified: true })).toBe(false);
  });

  it('can trust unverified addresses only when the setting says so', async () => {
    await insertProvider('corp');
    await provision('trust@example.com');
    await setScimSettings(ctx.db, { enabled: true, providerId: 'corp', requireVerifiedEmail: false });
    expect(await canLinkScimSignIn('corp', { email: 'trust@example.com' })).toBe(true);
  });

  it('never links twice, nor disabled, deleted or protected SCIM users', async () => {
    await insertProvider('corp');
    const id = await provision('once@example.com');
    await ctx.db.insert(schema.accounts).values({ userId: id, issuer: 'corp', accountId: 'sub-1', providerId: 'corp', createdAt: now(), updatedAt: now() });
    expect(await canLinkScimSignIn('corp', { email: 'once@example.com', email_verified: true })).toBe(false);

    const disabled = await provision('off@example.com');
    await ctx.db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, disabled));
    expect(await canLinkScimSignIn('corp', { email: 'off@example.com', email_verified: true })).toBe(false);

    const deleted = await provision('gone@example.com');
    await ctx.db.update(schema.scimUsers).set({ deletedAt: now() }).where(eq(schema.scimUsers.userId, deleted));
    expect(await canLinkScimSignIn('corp', { email: 'gone@example.com', email_verified: true })).toBe(false);

    const glass = await provision('glass2@example.com');
    await ctx.db.insert(schema.settings).values({ key: 'sso_enforcement', value: JSON.stringify({ enabled: false, breakGlassUserIds: [glass] }), updatedAt: now() });
    expect(await canLinkScimSignIn('corp', { email: 'glass2@example.com', email_verified: true })).toBe(false);
  });

  it('is what Better Auth sees as a verified address for a provider without auto-link', async () => {
    await insertProvider('corp');
    await provision('ba@example.com');
    const config = mapOAuthProvider({
      id: 'corp', name: 'Corp', type: 'oidc', clientId: 'cid', clientSecret: 'secret', issuer: 'https://idp.example.com',
      authorizationUrl: null, tokenUrl: null, userinfoUrl: null, scopes: 'openid email', autoLink: false, enabled: true,
      source: 'ui', createdAt: now(), updatedAt: now(),
    });
    const mapped = await config.mapProfileToUser!({ email: 'ba@example.com', email_verified: true } as never);
    expect(mapped).toEqual({ emailVerified: true });
    const other = await config.mapProfileToUser!({ email: 'someone@example.com', email_verified: true } as never);
    expect(other).toEqual({ emailVerified: false });
  });

  it('records the first link once', async () => {
    await insertProvider('corp');
    const id = await provision('rec@example.com');
    await noteScimSignInLink(id, 'corp');
    await noteScimSignInLink(id, 'corp');
    expect((await first(ctx.db.select().from(schema.scimUsers).where(eq(schema.scimUsers.userId, id)).limit(1)))?.linkedAt).toBeTruthy();
    expect(vi.mocked(logAuditEvent).mock.calls.filter(([event]) => event.action === 'scim_sso_link')).toHaveLength(1);
  });
});

describe('permissions', () => {
  it('has a paid scim area whose write is administrator-level', () => {
    expect(PERMISSION_AREAS.scim).toMatchObject({ actions: ['read', 'write'], paid: true });
    expect(isAdminLevel(['scim:write'])).toBe(true);
    expect(isAdminLevel(['scim:read'])).toBe(false);
  });
});
