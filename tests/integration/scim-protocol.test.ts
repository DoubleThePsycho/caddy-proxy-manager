/**
 * SCIM 2.0 conformance of /scim/v2 for the operations Microsoft Entra ID and
 * Okta use, through the real route handlers on a real database:
 *
 *  - authentication: only SCIM tokens, never API tokens or sessions (and
 *    SCIM tokens never work on /api/v1); expired tokens; SCIM turned off;
 *  - discovery documents; Users list/filter/paging, get, create, replace,
 *    PATCH (Entra and Okta shapes) and delete in both delete modes;
 *  - deprovisioning revokes dashboard sessions, forward-auth sessions and API
 *    tokens; an administrator's own disable is not undone by a routine sync;
 *  - local accounts are invisible and cannot be claimed; protected accounts
 *    (primary admin, break-glass) cannot be changed;
 *  - Groups mapped to forward-auth groups, member add/remove in every shape;
 *  - group-to-role mappings are the only source of roles, with the
 *    last-administrator guard;
 *  - every change is audited with the token that made it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import {
  body,
  entraUser,
  ERROR_SCHEMA,
  GROUP_SCHEMA,
  idParams,
  insertApiToken,
  insertLocalUser,
  insertScimToken,
  now,
  oktaUser,
  PATCH_SCHEMA,
  scimRequest,
  setScimSettings,
} from '../helpers/scim';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

import { logAuditEvent } from '../../src/lib/audit';
import * as usersRoute from '../../app/scim/v2/Users/route';
import * as userRoute from '../../app/scim/v2/Users/[id]/route';
import * as groupsRoute from '../../app/scim/v2/Groups/route';
import * as groupRoute from '../../app/scim/v2/Groups/[id]/route';
import * as providerConfigRoute from '../../app/scim/v2/ServiceProviderConfig/route';
import * as resourceTypesRoute from '../../app/scim/v2/ResourceTypes/route';
import * as schemasRoute from '../../app/scim/v2/Schemas/route';
import * as apiUsersRoute from '../../app/api/v1/users/route';
import { first } from '@/src/lib/db/ops';

const ADMIN_ID = 1;
let token: { id: number; raw: string };

beforeEach(async () => {
  ctx.db = createTestDb();
  vi.mocked(logAuditEvent).mockClear();
  await insertLocalUser(ctx.db, { id: ADMIN_ID, email: 'admin@localhost', role: 'admin' });
  token = await insertScimToken(ctx.db);
  await setScimSettings(ctx.db, {});
});

async function createUser(payload: unknown) {
  const response = await usersRoute.POST(scimRequest('POST', '/scim/v2/Users', token.raw, payload));
  return { response, json: await body(response) };
}

async function patchUser(id: string | number, ...operations: unknown[]) {
  const response = await userRoute.PATCH(
    scimRequest('PATCH', `/scim/v2/Users/${id}`, token.raw, { schemas: [PATCH_SCHEMA], Operations: operations }),
    idParams(id)
  );
  return { response, json: await body(response) };
}

async function patchGroup(id: string | number, ...operations: unknown[]) {
  const response = await groupRoute.PATCH(
    scimRequest('PATCH', `/scim/v2/Groups/${id}`, token.raw, { schemas: [PATCH_SCHEMA], Operations: operations }),
    idParams(id)
  );
  return { response, json: await body(response) };
}

async function userRow(id: number) {
  return await first(ctx.db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1));
}

function auditActions(): string[] {
  return vi.mocked(logAuditEvent).mock.calls.map(([event]) => event.action);
}

describe('authentication', () => {
  it('refuses requests without a token with a SCIM error and WWW-Authenticate', async () => {
    const response = await usersRoute.GET(scimRequest('GET', '/scim/v2/Users', null));
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe('application/scim+json');
    expect(response.headers.get('www-authenticate')).toMatch(/^Bearer/);
    expect(await body(response)).toMatchObject({ schemas: [ERROR_SCHEMA], status: '401' });
  });

  it('refuses an API token on the SCIM endpoints', async () => {
    const apiToken = await insertApiToken(ctx.db, ADMIN_ID);
    const response = await usersRoute.GET(scimRequest('GET', '/scim/v2/Users', apiToken));
    expect(response.status).toBe(401);
  });

  it('refuses a SCIM token on the REST API', async () => {
    const response = await apiUsersRoute.GET(scimRequest('GET', '/api/v1/users', token.raw) as never);
    expect(response.status).toBe(401);
    expect((await body(response)).error).toBe('Invalid or expired API token');
  });

  it('refuses expired, unknown and malformed tokens', async () => {
    const expired = await insertScimToken(ctx.db, { expiresAt: '2020-01-01T00:00:00.000Z' });
    for (const value of [expired.raw, 'scim_unknown', `${token.raw}x`, token.raw.slice(5)]) {
      const response = await usersRoute.GET(scimRequest('GET', '/scim/v2/Users', value));
      expect(response.status, value.slice(0, 12)).toBe(401);
    }
  });

  it('refuses every request while SCIM is turned off, without a license check', async () => {
    await setScimSettings(ctx.db, { enabled: false });
    const response = await usersRoute.GET(scimRequest('GET', '/scim/v2/Users', token.raw));
    expect(response.status).toBe(403);
    expect((await body(response)).detail).toMatch(/turned off/);
  });

  it('works without any license (runtime path)', async () => {
    expect(await first(ctx.db.select().from(schema.settings).where(eq(schema.settings.key, 'license')).limit(1))).toBeUndefined();
    const { response } = await createUser(entraUser('nolicense@example.com'));
    expect(response.status).toBe(201);
  });

  it('records when the token was last used', async () => {
    await usersRoute.GET(scimRequest('GET', '/scim/v2/Users', token.raw));
    const row = await first(ctx.db.select().from(schema.scimTokens).where(eq(schema.scimTokens.id, token.id)).limit(1));
    expect(row?.lastUsedAt).toBeTruthy();
  });
});

describe('discovery', () => {
  it('serves ServiceProviderConfig, ResourceTypes and Schemas as application/scim+json', async () => {
    const config = await providerConfigRoute.GET(scimRequest('GET', '/scim/v2/ServiceProviderConfig', token.raw));
    expect(config.headers.get('content-type')).toBe('application/scim+json');
    expect(await body(config)).toMatchObject({ patch: { supported: true }, bulk: { supported: false }, filter: { supported: true } });
    const types = await body(await resourceTypesRoute.GET(scimRequest('GET', '/scim/v2/ResourceTypes', token.raw)));
    expect(types.Resources.map((type: { id: string }) => type.id)).toEqual(['User', 'Group']);
    const schemas = await body(await schemasRoute.GET(scimRequest('GET', '/scim/v2/Schemas', token.raw)));
    expect(schemas.totalResults).toBe(2);
  });
});

describe('Users', () => {
  it('creates an Entra ID user with no password, no username and the default role', async () => {
    const { response, json } = await createUser(entraUser('Alice.Smith@Example.com'));
    expect(response.status).toBe(201);
    expect(response.headers.get('location')).toMatch(new RegExp(`/scim/v2/Users/${json.id}$`));
    expect(json.meta.location).toBe(response.headers.get('location'));
    expect(json).toMatchObject({
      userName: 'Alice.Smith@Example.com',
      externalId: 'Alice.Smith-nick',
      active: true,
      displayName: 'Entra User',
      emails: [{ value: 'Alice.Smith@Example.com', type: 'work', primary: true }],
      groups: [],
      meta: { resourceType: 'User' },
    });
    const row = (await userRow(Number(json.id)))!;
    expect(row).toMatchObject({
      email: 'alice.smith@example.com', name: 'Entra User', role: 'user', status: 'active', passwordHash: null, username: null, provider: null,
    });
    expect(await ctx.db.select().from(schema.accounts).where(eq(schema.accounts.userId, row.id))).toEqual([]);
    const event = vi.mocked(logAuditEvent).mock.calls.find(([entry]) => entry.action === 'scim_user_create')![0];
    expect(event).toMatchObject({ userId: null, entityType: 'user', entityId: row.id });
    expect(event.summary).toContain('SCIM token "Entra ID"');
    expect(event.data).toMatchObject({ source: 'scim', scimTokenId: token.id, scimTokenName: 'Entra ID' });
  });

  it('ignores roles and passwords in an Okta create body', async () => {
    await setScimSettings(ctx.db, { defaultRole: 'viewer' });
    const { response, json } = await createUser(oktaUser('bob@example.com', { roles: [{ value: 'admin', primary: true }] }));
    expect(response.status).toBe(201);
    expect(await userRow(Number(json.id))).toMatchObject({ role: 'viewer', customRoleId: null, passwordHash: null });
  });

  it('refuses a duplicate userName in any case (409 uniqueness)', async () => {
    await createUser(entraUser('carol@example.com'));
    const { response, json } = await createUser(entraUser('CAROL@example.com', { emails: [{ value: 'carol2@example.com', primary: true }] }));
    expect(response.status).toBe(409);
    expect(json).toMatchObject({ schemas: [ERROR_SCHEMA], status: '409', scimType: 'uniqueness' });
  });

  it('never claims a local account with the same e-mail address', async () => {
    const local = await insertLocalUser(ctx.db, { email: 'dave@example.com', role: 'admin', name: 'Local Dave' });
    const { response, json } = await createUser(entraUser('dave@example.com'));
    expect(response.status).toBe(409);
    expect(json.detail).toMatch(/not managed by SCIM/);
    expect(await userRow(local)).toMatchObject({ role: 'admin', name: 'Local Dave', status: 'active' });
    expect(await ctx.db.select().from(schema.scimUsers)).toEqual([]);
  });

  it('refuses users without an e-mail address or with a portal address', async () => {
    expect((await createUser({ userName: 'noemail' })).response.status).toBe(400);
    expect((await createUser(entraUser('root@localhost'))).response.status).toBe(400);
    const malformed = await usersRoute.POST(scimRequest('POST', '/scim/v2/Users', token.raw, '{not json'));
    expect(malformed.status).toBe(400);
    expect((await body(malformed)).scimType).toBe('invalidSyntax');
  });

  it('finds users by userName and externalId, pages, and answers an unknown name with zero results', async () => {
    for (const name of ['u1@example.com', 'u2@example.com', 'u3@example.com']) await createUser(entraUser(name));
    const find = async (query: string) => body(await usersRoute.GET(scimRequest('GET', `/scim/v2/Users?${query}`, token.raw)));
    expect((await find(`filter=${encodeURIComponent('userName eq "U2@EXAMPLE.COM"')}`)).Resources.map((u: { userName: string }) => u.userName)).toEqual(['u2@example.com']);
    expect((await find(`filter=${encodeURIComponent('externalId eq "u3-nick"')}`)).totalResults).toBe(1);
    // Entra ID's "test connection" asks for a random userName.
    expect(await find(`filter=${encodeURIComponent('userName eq "0f0e1d2c-3b4a"')}`)).toMatchObject({ totalResults: 0, Resources: [] });
    const page = await find('startIndex=2&count=1');
    expect(page).toMatchObject({ totalResults: 3, startIndex: 2, itemsPerPage: 1 });
    expect(page.Resources[0].userName).toBe('u2@example.com');
    const bad = await usersRoute.GET(scimRequest('GET', `/scim/v2/Users?filter=${encodeURIComponent('title eq "x"')}`, token.raw));
    expect(bad.status).toBe(400);
    expect((await body(bad)).scimType).toBe('invalidFilter');
  });

  it('keeps local accounts invisible', async () => {
    await insertLocalUser(ctx.db, { email: 'erin@example.com' });
    expect((await userRoute.GET(scimRequest('GET', '/scim/v2/Users/1', token.raw), idParams(1))).status).toBe(404);
    const list = await body(await usersRoute.GET(scimRequest('GET', '/scim/v2/Users', token.raw)));
    expect(list.totalResults).toBe(0);
    const patch = await patchUser(1, { op: 'replace', path: 'active', value: false });
    expect(patch.response.status).toBe(404);
    expect((await userRow(ADMIN_ID))?.status).toBe('active');
  });

  it('applies Entra ID PATCH requests', async () => {
    const { json: created } = await createUser(entraUser('frank@example.com'));
    const { response, json } = await patchUser(
      created.id,
      { op: 'Replace', path: 'displayName', value: 'Frank F.' },
      { op: 'Add', path: 'emails[type eq "work"].value', value: 'frank.new@example.com' },
      { op: 'Replace', path: 'name.givenName', value: 'Franklin' },
      { op: 'Add', path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:manager', value: '7' }
    );
    expect(response.status).toBe(200);
    expect(json).toMatchObject({ displayName: 'Frank F.', name: { givenName: 'Franklin' }, emails: [{ value: 'frank.new@example.com' }] });
    expect(await userRow(Number(created.id))).toMatchObject({ email: 'frank.new@example.com', name: 'Frank F.' });
    expect(auditActions()).toContain('scim_user_update');
  });

  it('refuses a PATCH that would take another account\'s e-mail address', async () => {
    await insertLocalUser(ctx.db, { email: 'taken@example.com' });
    const { json: created } = await createUser(entraUser('gina@example.com'));
    const { response } = await patchUser(created.id, { op: 'Replace', path: 'emails[type eq "work"].value', value: 'taken@example.com' });
    expect(response.status).toBe(409);
    expect((await userRow(Number(created.id)))?.email).toBe('gina@example.com');
  });

  describe('deprovisioning', () => {
    async function seedSignIns(userId: number) {
      const later = new Date(Date.now() + 3_600_000).toISOString();
      await ctx.db.insert(schema.sessions).values({ userId, token: `s-${userId}`, expiresAt: later, createdAt: now(), updatedAt: now() });
      const host = (await first(ctx.db.insert(schema.proxyHosts).values({
        name: `host-${userId}`, domains: '["app.example.com"]', upstreams: '["backend:8080"]', createdAt: now(), updatedAt: now(),
      }).returning()))!;
      await ctx.db.insert(schema.forwardAuthSessions).values({
        userId, proxyHostId: host.id, audienceOrigin: 'https://app.example.com', tokenHash: `fa-${userId}`, expiresAt: later, createdAt: now(),
      });
      await insertApiToken(ctx.db, userId);
    }

    async function signIns(userId: number) {
      return {
        sessions: (await ctx.db.select().from(schema.sessions).where(eq(schema.sessions.userId, userId))).length,
        forwardAuth: (await ctx.db.select().from(schema.forwardAuthSessions).where(eq(schema.forwardAuthSessions.userId, userId))).length,
        apiTokens: (await ctx.db.select().from(schema.apiTokens).where(eq(schema.apiTokens.createdBy, userId))).length,
      };
    }

    it('Entra ID "active": "False" disables the account and revokes sessions, forward-auth sessions and API tokens', async () => {
      const { json: created } = await createUser(entraUser('henry@example.com'));
      const id = Number(created.id);
      await seedSignIns(id);
      expect(await signIns(id)).toEqual({ sessions: 1, forwardAuth: 1, apiTokens: 1 });
      const { response, json } = await patchUser(id, { op: 'Replace', path: 'active', value: 'False' });
      expect(response.status).toBe(200);
      expect(json.active).toBe(false);
      expect((await userRow(id))?.status).toBe('disabled');
      expect(await signIns(id)).toEqual({ sessions: 0, forwardAuth: 0, apiTokens: 0 });
      expect(auditActions()).toContain('scim_user_deactivate');

      const reactivated = await patchUser(id, { op: 'Replace', path: 'active', value: 'True' });
      expect(reactivated.json.active).toBe(true);
      expect((await userRow(id))?.status).toBe('active');
    });

    it('Okta path-less {"active": false} and PUT with active false disable too', async () => {
      const { json: a } = await createUser(oktaUser('ivy@example.com'));
      await seedSignIns(Number(a.id));
      await patchUser(a.id, { op: 'replace', value: { active: false } });
      expect((await userRow(Number(a.id)))?.status).toBe('disabled');
      expect((await signIns(Number(a.id))).apiTokens).toBe(0);

      const { json: b } = await createUser(oktaUser('jack@example.com', { externalId: '00u2' }));
      const put = await userRoute.PUT(scimRequest('PUT', `/scim/v2/Users/${b.id}`, token.raw, oktaUser('jack@example.com', { active: false })), idParams(b.id));
      expect(put.status).toBe(200);
      expect((await userRow(Number(b.id)))?.status).toBe('disabled');
    });

    it('does not undo an administrator\'s own disable when the provider keeps sending active=true', async () => {
      const { json: created } = await createUser(oktaUser('kim@example.com'));
      await ctx.db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, Number(created.id)));
      await userRoute.PUT(scimRequest('PUT', `/scim/v2/Users/${created.id}`, token.raw, oktaUser('kim@example.com', { displayName: 'Kim' })), idParams(created.id));
      expect(await userRow(Number(created.id))).toMatchObject({ status: 'disabled', name: 'Kim' });
    });

    it('DELETE disables by default, hides the user, and a later create restores the same account', async () => {
      const { json: created } = await createUser(entraUser('liam@example.com'));
      const id = Number(created.id);
      await seedSignIns(id);
      const response = await userRoute.DELETE(scimRequest('DELETE', `/scim/v2/Users/${id}`, token.raw), idParams(id));
      expect(response.status).toBe(204);
      expect((await userRow(id))?.status).toBe('disabled');
      expect(await signIns(id)).toEqual({ sessions: 0, forwardAuth: 0, apiTokens: 0 });
      expect((await userRoute.GET(scimRequest('GET', `/scim/v2/Users/${id}`, token.raw), idParams(id))).status).toBe(404);

      const again = await createUser(entraUser('liam@example.com'));
      expect(again.response.status).toBe(201);
      expect(Number(again.json.id)).toBe(id);
      expect((await userRow(id))?.status).toBe('active');
    });

    it('DELETE deletes the account in delete mode', async () => {
      await setScimSettings(ctx.db, { deleteMode: 'delete' });
      const { json: created } = await createUser(entraUser('mia@example.com'));
      const id = Number(created.id);
      await seedSignIns(id);
      expect((await userRoute.DELETE(scimRequest('DELETE', `/scim/v2/Users/${id}`, token.raw), idParams(id))).status).toBe(204);
      expect(await userRow(id)).toBeUndefined();
      expect(await ctx.db.select().from(schema.scimUsers)).toEqual([]);
      expect(await signIns(id)).toEqual({ sessions: 0, forwardAuth: 0, apiTokens: 0 });
      expect(auditActions()).toContain('scim_user_delete');
    });
  });

  describe('protected accounts', () => {
    it('refuses changing or deleting a SCIM user that became a break-glass account', async () => {
      const { json: created } = await createUser(entraUser('nora@example.com'));
      const id = Number(created.id);
      await ctx.db.insert(schema.settings).values({
        key: 'sso_enforcement', value: JSON.stringify({ enabled: false, breakGlassUserIds: [id] }), updatedAt: now(),
      });
      const patch = await patchUser(id, { op: 'replace', path: 'active', value: false });
      expect(patch.response.status).toBe(403);
      const put = await userRoute.PUT(scimRequest('PUT', `/scim/v2/Users/${id}`, token.raw, entraUser('nora@example.com', { active: false })), idParams(id));
      expect(put.status).toBe(403);
      expect((await userRoute.DELETE(scimRequest('DELETE', `/scim/v2/Users/${id}`, token.raw), idParams(id))).status).toBe(403);
      expect((await userRow(id))?.status).toBe('active');
    });

    it('refuses deactivating the last active administrator', async () => {
      const { json: created } = await createUser(entraUser('olga@example.com'));
      const id = Number(created.id);
      await ctx.db.update(schema.users).set({ role: 'admin' }).where(eq(schema.users.id, id));
      await ctx.db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, ADMIN_ID));
      const { response, json } = await patchUser(id, { op: 'replace', path: 'active', value: false });
      expect(response.status).toBe(400);
      expect(json.detail).toMatch(/no active administrator/);
      expect((await userRow(id))?.status).toBe('active');
    });
  });
});

describe('Groups', () => {
  async function scimUser(name: string): Promise<number> {
    return Number((await createUser(entraUser(name))).json.id);
  }

  async function createGroup(payload: unknown) {
    const response = await groupsRoute.POST(scimRequest('POST', '/scim/v2/Groups', token.raw, payload));
    return { response, json: await body(response) };
  }

  async function members(groupId: number): Promise<number[]> {
    return (await ctx.db.select({ userId: schema.groupMembers.userId }).from(schema.groupMembers)
      .where(eq(schema.groupMembers.groupId, groupId))).map((row) => row.userId).sort((a, b) => a - b);
  }

  it('creates a forward-auth group with members (Okta group push)', async () => {
    const a = await scimUser('pa@example.com');
    const { response, json } = await createGroup({ schemas: [GROUP_SCHEMA], displayName: 'Engineering', members: [{ value: String(a), display: 'pa@example.com' }] });
    expect(response.status).toBe(201);
    expect(json).toMatchObject({ displayName: 'Engineering', members: [{ value: String(a) }] });
    expect((await first(ctx.db.select().from(schema.groups).where(eq(schema.groups.id, Number(json.id))).limit(1)))?.name).toBe('Engineering');
    expect(await members(Number(json.id))).toEqual([a]);
    expect(auditActions()).toEqual(expect.arrayContaining(['scim_group_create', 'scim_group_members']));
  });

  it('finds groups by displayName and leaves members out on request', async () => {
    const a = await scimUser('qa@example.com');
    await createGroup({ displayName: 'Ops', members: [{ value: String(a) }] });
    const found = await body(await groupsRoute.GET(scimRequest('GET', `/scim/v2/Groups?filter=${encodeURIComponent('displayName eq "ops"')}&excludedAttributes=members`, token.raw)));
    expect(found.totalResults).toBe(1);
    expect(found.Resources[0].members).toBeUndefined();
  });

  it('adds and removes members in Entra ID and Okta shapes', async () => {
    const [a, b, c] = [await scimUser('ra@example.com'), await scimUser('rb@example.com'), await scimUser('rc@example.com')];
    const { json: group } = await createGroup({ displayName: 'Sales' });
    const id = Number(group.id);
    // Entra ID add.
    expect((await patchGroup(id, { op: 'Add', path: 'members', value: [{ value: String(a) }, { value: String(b) }] })).response.status).toBe(200);
    expect(await members(id)).toEqual([a, b]);
    // Entra ID remove with a value list.
    await patchGroup(id, { op: 'Remove', path: 'members', value: [{ value: String(a) }] });
    expect(await members(id)).toEqual([b]);
    // Okta remove by filter.
    await patchGroup(id, { op: 'remove', path: `members[value eq "${b}"]` });
    expect(await members(id)).toEqual([]);
    // Okta replace of the whole list, and a path-less rename.
    await patchGroup(id, { op: 'replace', path: 'members', value: [{ value: String(c) }] }, { op: 'replace', value: { id: String(id), displayName: 'Sales EMEA' } });
    expect(await members(id)).toEqual([c]);
    expect((await first(ctx.db.select().from(schema.groups).where(eq(schema.groups.id, id)).limit(1)))?.name).toBe('Sales EMEA');
  });

  it('refuses members that are not SCIM users', async () => {
    const local = await insertLocalUser(ctx.db, { email: 'local@example.com' });
    const { json: group } = await createGroup({ displayName: 'Support' });
    const { response, json } = await patchGroup(group.id, { op: 'add', path: 'members', value: [{ value: String(local) }] });
    expect(response.status).toBe(400);
    expect(json.scimType).toBe('invalidValue');
    expect((await patchGroup(group.id, { op: 'add', path: 'members', value: [{ value: String(ADMIN_ID) }] })).response.status).toBe(400);
    expect(await members(Number(group.id))).toEqual([]);
  });

  it('never takes over a local group with the same name, and only touches SCIM members of a handed-over group', async () => {
    const local = (await first(ctx.db.insert(schema.groups).values({ name: 'Admins', createdAt: now(), updatedAt: now() }).returning()))!;
    const localMember = await insertLocalUser(ctx.db, { email: 'member@example.com' });
    await ctx.db.insert(schema.groupMembers).values({ groupId: local.id, userId: localMember, createdAt: now() });
    const conflict = await createGroup({ displayName: 'admins' });
    expect(conflict.response.status).toBe(409);
    expect(conflict.json.detail).toMatch(/not managed by SCIM/);

    // An administrator hands the group to SCIM.
    await ctx.db.insert(schema.scimGroups).values({ groupId: local.id, origin: 'adopted', createdAt: now(), updatedAt: now() });
    const a = await scimUser('sa@example.com');
    const replaced = await groupRoute.PUT(scimRequest('PUT', `/scim/v2/Groups/${local.id}`, token.raw, { displayName: 'Admins', members: [{ value: String(a) }] }), idParams(local.id));
    expect(replaced.status).toBe(200);
    expect((await body(replaced)).members.map((m: { value: string }) => m.value)).toEqual([String(a)]);
    expect(await members(local.id)).toEqual([localMember, a].sort((x, y) => x - y));

    // Deleting a handed-over group removes only the SCIM members and keeps the group.
    expect((await groupRoute.DELETE(scimRequest('DELETE', `/scim/v2/Groups/${local.id}`, token.raw), idParams(local.id))).status).toBe(204);
    expect(await members(local.id)).toEqual([localMember]);
    expect(await first(ctx.db.select().from(schema.groups).where(eq(schema.groups.id, local.id)).limit(1))).toBeTruthy();
    expect((await groupRoute.GET(scimRequest('GET', `/scim/v2/Groups/${local.id}`, token.raw), idParams(local.id))).status).toBe(404);
  });

  it('deletes a group SCIM created with its memberships and forward-auth grants', async () => {
    const a = await scimUser('ta@example.com');
    const { json: group } = await createGroup({ displayName: 'Temp', members: [{ value: String(a) }] });
    const id = Number(group.id);
    const host = (await first(ctx.db.insert(schema.proxyHosts).values({ name: 'h', domains: '["h.example.com"]', upstreams: '["b:80"]', createdAt: now(), updatedAt: now() }).returning()))!;
    await ctx.db.insert(schema.forwardAuthAccess).values({ proxyHostId: host.id, groupId: id, createdAt: now() });
    expect((await groupRoute.DELETE(scimRequest('DELETE', `/scim/v2/Groups/${id}`, token.raw), idParams(id))).status).toBe(204);
    expect(await first(ctx.db.select().from(schema.groups).where(eq(schema.groups.id, id)).limit(1))).toBeUndefined();
    expect(await members(id)).toEqual([]);
    expect(await ctx.db.select().from(schema.forwardAuthAccess).where(eq(schema.forwardAuthAccess.groupId, id))).toEqual([]);
  });

  it('lists the SCIM groups a user is in on the user', async () => {
    const a = await scimUser('ua@example.com');
    const { json: group } = await createGroup({ displayName: 'Readers', members: [{ value: String(a) }] });
    const user = await body(await userRoute.GET(scimRequest('GET', `/scim/v2/Users/${a}`, token.raw), idParams(a)));
    expect(user.groups).toEqual([expect.objectContaining({ value: String(group.id), display: 'Readers' })]);
  });
});

describe('group-to-role mappings', () => {
  async function setup(role: string, customRoleId: number | null = null) {
    const user = Number((await createUser(entraUser('role@example.com'))).json.id);
    const group = await body(await groupsRoute.POST(scimRequest('POST', '/scim/v2/Groups', token.raw, { displayName: 'Mapped' })));
    await ctx.db.insert(schema.scimRoleMappings).values({ groupId: Number(group.id), role, customRoleId, priority: 10, createdAt: now(), updatedAt: now() });
    return { user, group: Number(group.id) };
  }

  it('grants nothing while SCIM does not manage roles', async () => {
    const { user, group } = await setup('admin');
    await patchGroup(group, { op: 'add', path: 'members', value: [{ value: String(user) }] });
    expect((await userRow(user))?.role).toBe('user');
  });

  it('gives the mapped role on joining and the default role on leaving', async () => {
    await setScimSettings(ctx.db, { manageRoles: true });
    const { user, group } = await setup('admin');
    await patchGroup(group, { op: 'add', path: 'members', value: [{ value: String(user) }] });
    expect((await userRow(user))?.role).toBe('admin');
    expect(auditActions()).toContain('scim_role_change');
    await patchGroup(group, { op: 'remove', path: `members[value eq "${user}"]` });
    expect((await userRow(user))?.role).toBe('user');
  });

  it('maps custom roles (stored as viewer plus customRoleId)', async () => {
    await setScimSettings(ctx.db, { manageRoles: true });
    const role = (await first(ctx.db.insert(schema.customRoles).values({ name: 'Ops', permissions: '["proxy_hosts:read"]', createdAt: now(), updatedAt: now() }).returning()))!;
    const { user, group } = await setup('viewer', role.id);
    await patchGroup(group, { op: 'add', path: 'members', value: [{ value: String(user) }] });
    expect(await userRow(user)).toMatchObject({ role: 'viewer', customRoleId: role.id });
  });

  it('keeps the last active administrator and records the refusal', async () => {
    await setScimSettings(ctx.db, { manageRoles: true });
    const { user, group } = await setup('admin');
    await patchGroup(group, { op: 'add', path: 'members', value: [{ value: String(user) }] });
    await ctx.db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, ADMIN_ID));
    const { response } = await patchGroup(group, { op: 'remove', path: `members[value eq "${user}"]` });
    expect(response.status).toBe(200);
    expect((await userRow(user))?.role).toBe('admin');
    expect(auditActions()).toContain('scim_role_change_refused');
    // The membership change itself went through.
    expect(await first(ctx.db.select().from(schema.groupMembers).where(and(eq(schema.groupMembers.groupId, group), eq(schema.groupMembers.userId, user))).limit(1))).toBeUndefined();
  });
});
