/**
 * The identity overviews behind Users and groups and Sign-in and directories
 * (src/lib/users-overview.ts, src/lib/sign-in-overview.ts) and their REST
 * routes: sources, second factors, administrators without one, roles a
 * directory or SCIM sets, groups with SCIM management, role mappings and the
 * hosts they open (limited by permission and tag scope), enforced SSO with
 * refused passwords, directory health, SCIM activity, and no secret in any
 * answer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb, permissions: [] as string[] }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('../../src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-auth')>();
  return {
    ...actual,
    requireApiPermission: vi.fn(async (_request: unknown, permission: string) => {
      ctx.permissions.push(permission);
      const { builtInAccess } = await import('../../src/lib/permissions');
      return { userId: 1, role: 'admin', authMethod: 'bearer', access: builtInAccess(1, 'admin') };
    }),
  };
});

import { adminAccess, type Access, type Permission } from '../../src/lib/permissions';
import { getGroupsOverview, getUsersOverview } from '../../src/lib/users-overview';
import { getSignInOverview } from '../../src/lib/sign-in-overview';
import * as usersRoute from '../../app/api/v1/users/overview/route';
import * as groupsRoute from '../../app/api/v1/groups/overview/route';
import * as signInRoute from '../../app/api/v1/sign-in/overview/route';
import { first } from '@/src/lib/db/ops';

const NOW = new Date('2026-10-03T11:36:00.000Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const T = ago(300);

function roleAccess(permissions: Permission[], scopeTags: string[] = []): Access {
  return {
    userId: 99,
    role: 'viewer',
    isAdmin: false,
    customRole: { id: 9, name: 'Test role' },
    permissions: new Set(permissions),
    scopeTags,
  };
}

type Ids = Record<'admin' | 'breakglass' | 'corp' | 'saml' | 'scim' | 'robot', number> & { directory: number; samlProvider: number; hostA: number; hostB: number; local: number; scimGroup: number };

async function seed(): Promise<Ids> {
  const db = ctx.db;
  const user = async (email: string, values: Partial<typeof schema.users.$inferInsert> = {}) =>
    (await first(db.insert(schema.users).values({ email, name: email.split('@')[0], role: 'user', status: 'active', createdAt: T, updatedAt: T, ...values }).returning()))!.id;
  const account = async (userId: number, providerId: string, password: string | null = null) =>
    await db.insert(schema.accounts).values({ userId, accountId: `${userId}-${providerId}`, providerId, password, createdAt: T, updatedAt: T });

  const admin = await user('admin@example.com', { role: 'admin', username: 'admin', twoFactorEnabled: true, lastSignInAt: ago(1), lastSignInMethod: 'sso' });
  const breakglass = await user('ops@example.com', { role: 'admin', username: 'breakglass', name: 'Break glass', lastSignInAt: ago(50), lastSignInMethod: 'password' });
  const corp = await user('corp@example.com', { role: 'admin', lastSignInAt: ago(5), lastSignInMethod: 'ldap' });
  const saml = await user('saml@example.com', { role: 'viewer', lastSignInAt: ago(2), lastSignInMethod: 'saml' });
  const scim = await user('scim@example.com', { role: 'viewer' });
  const robot = await user('robot@example.com', { role: 'user' });

  await db.insert(schema.twoFactors).values({ userId: admin, secret: 'enc', backupCodes: 'enc', verified: true });
  await db.insert(schema.passkeys).values({
    userId: breakglass, name: 'Key', publicKey: 'pk', credentialID: 'cred-1', counter: 0, deviceType: 'singleDevice', backedUp: false, createdAt: T,
  } as typeof schema.passkeys.$inferInsert);

  await db.insert(schema.oauthProviders).values({
    id: 'corp-idp', name: 'Corporate IdP', clientId: 'client-id-value', clientSecret: 'super-secret-client-value', issuer: 'https://auth.example.com/o/',
    createdAt: T, updatedAt: T,
  });
  const directory = (await first(db.insert(schema.ldapDirectories).values({
    name: 'Corp directory', url: 'ldaps://dc01.example.com:636', bindDn: 'cn=svc', bindPassword: 'bind-password-secret', userSearchBase: 'dc=example,dc=com',
    userSearchFilter: '(uid={username})', allowWhenSsoEnforced: true,
    groupRoleMappings: JSON.stringify([{ group: 'cn=admins,dc=example,dc=com', role: 'admin' }]), createdAt: T, updatedAt: T,
  }).returning()))!.id;
  await db.insert(schema.ldapDirectoryHealth).values({
    directoryId: directory, status: 'failing', checkedAt: ago(0), lastSuccessAt: ago(3), lastFailureAt: ago(0), failingSince: ago(1),
    lastError: 'Service account bind: invalid credentials (LDAP result 49)', consecutiveFailures: 17,
  });
  const samlProvider = (await first(db.insert(schema.samlProviders).values({
    name: 'Entra ID', idpEntityId: 'https://sts.example.com/', idpSsoUrl: 'https://login.example.com/saml', idpCertificates: '[]', createdAt: T, updatedAt: T,
  }).returning()))!.id;
  await db.insert(schema.samlGroupRoles).values({ providerId: samlProvider, groupValue: 'ingressi-admins', role: 'admin', createdAt: T });

  await account(admin, 'credential', 'hash');
  await account(admin, 'corp-idp');
  await account(breakglass, 'credential', 'hash');
  await account(corp, `ldap:${directory}`);
  await account(saml, `saml:${samlProvider}`);
  // The newest sign-in through each provider, as the session hook records it (src/lib/sign-in-activity.ts).
  const signedIn = async (providerId: string, at: string, userId: number | null) =>
    await db.insert(schema.signInSources).values({ providerId, lastSignInAt: at, lastUserId: userId });
  await signedIn('corp-idp', ago(1), admin);
  await signedIn(`saml:${samlProvider}`, ago(2), saml);
  await signedIn(`ldap:${directory}`, ago(5), corp);

  await db.insert(schema.scimUsers).values({ userId: scim, userName: 'scim@example.com', userNameKey: 'scim@example.com', createdAt: T, updatedAt: T });
  await db.insert(schema.settings).values({ key: 'scim', value: JSON.stringify({ enabled: true, manageRoles: true, deleteMode: 'disable', defaultRole: 'viewer' }), updatedAt: T });
  await db.insert(schema.scimTokens).values({ name: 'Entra', prefix: 'scim_abc', tokenHash: 'hash-1', createdAt: T, lastUsedAt: ago(0) });
  await db.insert(schema.apiTokens).values({ name: 'deploy', tokenHash: 'api-hash', createdBy: robot, createdAt: T, lastUsedAt: ago(1) } as typeof schema.apiTokens.$inferInsert);

  await db.insert(schema.settings).values({ key: 'sso_enforcement', value: JSON.stringify({ enabled: true, breakGlassUserIds: [breakglass] }), updatedAt: T });
  await db.insert(schema.settings).values({ key: 'mfa_policy', value: JSON.stringify({ scope: 'admins', graceDays: 7, since: ago(30) }), updatedAt: T });

  const audit = async (action: string, at: string, userId: number | null, summary: string) =>
    await db.insert(schema.auditEvents).values({ userId, action, entityType: 'user', summary, createdAt: at });
  await audit('sso_enforcement_updated', ago(20), admin, 'Turned enforced SSO on');
  await audit('sso_enforced_sign_in_refused', ago(1), null, 'Password sign-in refused');
  await audit('sso_enforced_sign_in_refused', ago(6), null, 'Password sign-in refused');
  await audit('sso_enforced_sign_in_refused', ago(9), null, 'Password sign-in refused');
  await audit('create', ago(0), null, 'SCIM token "Entra": created user 5 (scim@example.com)');

  const host = async (name: string, domain: string, tags: string[]) =>
    (await first(db.insert(schema.proxyHosts).values({ name, domains: JSON.stringify([domain]), upstreams: '["app:80"]', tags: JSON.stringify(tags), createdAt: T, updatedAt: T }).returning()))!.id;
  const hostA = await host('Grafana', 'grafana.example.com', ['team-a']);
  const hostB = await host('Wiki', 'wiki.example.com', ['team-b']);
  const group = async (name: string) => (await first(db.insert(schema.groups).values({ name, createdAt: T, updatedAt: T }).returning()))!.id;
  const local = await group('ops');
  const scimGroup = await group('ingressi-users');
  await db.insert(schema.groupMembers).values({ groupId: local, userId: admin, createdAt: T });
  await db.insert(schema.groupMembers).values({ groupId: scimGroup, userId: scim, createdAt: T });
  await db.insert(schema.forwardAuthAccess).values({ proxyHostId: hostA, groupId: local, createdAt: T });
  await db.insert(schema.forwardAuthAccess).values({ proxyHostId: hostB, groupId: local, createdAt: T });
  await db.insert(schema.scimGroups).values({ groupId: scimGroup, origin: 'scim', createdAt: T, updatedAt: ago(0) });
  await db.insert(schema.scimRoleMappings).values({ groupId: scimGroup, role: 'user', priority: 1, createdAt: T, updatedAt: T });

  return { admin, breakglass, corp, saml, scim, robot, directory, samlProvider, hostA, hostB, local, scimGroup };
}

let ids: Ids;

beforeEach(async () => {
  ctx.db = createTestDb();
  ctx.permissions = [];
  ids = await seed();
});

describe('users overview', () => {
  it('describes where each account comes from, its second factor and who sets its role', async () => {
    const overview = await getUsersOverview(adminAccess(ids.admin), NOW);
    const user = (id: number) => overview.users.find((entry) => entry.id === id)!;

    expect(user(ids.admin)).toMatchObject({
      primaryAdmin: true,
      administrator: true,
      sources: [{ kind: 'local', label: 'Password' }, { kind: 'oidc', label: 'Corporate IdP' }],
      secondFactor: { state: 'authenticator_app', authenticatorApp: true },
      lastSignInMethod: 'sso',
    });
    expect(user(ids.breakglass)).toMatchObject({ breakGlass: true, secondFactor: { state: 'passkey', passkeys: 1 }, passwordSignIn: true });
    // A directory administrator signs in with a password and has no second factor; the directory sets the role.
    expect(user(ids.corp)).toMatchObject({
      administrator: true,
      passwordSignIn: true,
      secondFactor: { state: 'none', required: true, gate: 'required' },
      roleManagedBy: 'Corp directory sets the role at each sign-in',
    });
    expect(user(ids.saml)).toMatchObject({
      secondFactor: { state: 'identity_provider' },
      roleManagedBy: 'Entra ID sets the role at each sign-in',
      administrator: false,
    });
    expect(user(ids.scim)).toMatchObject({ sources: [{ kind: 'scim', label: 'SCIM provisioning' }], secondFactor: { state: 'not_needed' }, invited: true, roleManagedBy: 'SCIM group mappings set the role' });
    expect(user(ids.robot)).toMatchObject({ sources: [], invited: false, apiTokenLastUsedAt: ago(1) });
    expect(overview.mfaPolicy).toMatchObject({ scope: 'admins', graceDays: 7 });
    expect(JSON.stringify(overview)).not.toMatch(/passwordHash|super-secret|bind-password/);
  });

  it('leaves out the MFA policy without mfa_policy:read', async () => {
    const overview = await getUsersOverview(roleAccess(['users:read']), NOW);
    expect(overview.mfaPolicy).toBeNull();
    expect(overview.users.length).toBe(6);
  });
});

describe('groups overview', () => {
  it('shows members, SCIM management, role mappings and every host for an administrator', async () => {
    const overview = await getGroupsOverview(adminAccess(ids.admin), NOW);
    const ops = overview.groups.find((group) => group.id === ids.local)!;
    const synced = overview.groups.find((group) => group.id === ids.scimGroup)!;
    expect(ops).toMatchObject({ scim: null, roleMappings: [], members: [{ userId: ids.admin }] });
    expect(ops.hosts!.map((host) => host.domain)).toEqual(['grafana.example.com', 'wiki.example.com']);
    expect(synced).toMatchObject({ scim: { origin: 'scim' }, roleMappings: [{ role: 'user', priority: 1 }], hosts: [] });
  });

  it('limits hosts to the tag scope and hides what the role cannot read', async () => {
    const scoped = await getGroupsOverview(roleAccess(['groups:read', 'proxy_hosts:read'], ['team-a']), NOW);
    const ops = scoped.groups.find((group) => group.id === ids.local)!;
    expect(ops.hosts!.map((host) => host.domain)).toEqual(['grafana.example.com']);
    expect(ops.roleMappings).toBeNull();

    const groupsOnly = await getGroupsOverview(roleAccess(['groups:read']), NOW);
    expect(groupsOnly.groups.every((group) => group.hosts === null && group.roleMappings === null)).toBe(true);
  });
});

describe('sign-in overview', () => {
  it("takes each provider's last activity from its own sign-ins, whoever made them", async () => {
    // The administrator is linked to a second IdP too, and a since-deleted account used it last.
    await ctx.db.insert(schema.oauthProviders).values({
      id: 'second-idp', name: 'Second IdP', clientId: 'second-client', clientSecret: 'second-secret', issuer: 'https://id2.example.com/', createdAt: T, updatedAt: T,
    });
    await ctx.db.insert(schema.accounts).values({ userId: ids.admin, accountId: 'admin-second', providerId: 'second-idp', password: null, createdAt: T, updatedAt: T });
    await ctx.db.insert(schema.signInSources).values({ providerId: 'second-idp', lastSignInAt: ago(0), lastUserId: 9_999 });

    const overview = await getSignInOverview(adminAccess(ids.admin), NOW);
    const lastSignIn = new Map(overview.oidc.map((provider) => [provider.id, provider.lastSignIn]));
    expect(lastSignIn.get('corp-idp')).toEqual({ at: ago(1), user: 'admin' });
    expect(lastSignIn.get('second-idp')).toEqual({ at: ago(0), user: 'Deleted account' });
  });

  it('summarises enforced SSO, the login page and every source', async () => {
    const overview = await getSignInOverview(adminAccess(ids.admin), NOW);
    expect(overview.enforcement).toMatchObject({ enabled: true, refusedLastWeek: 2, changedBy: 'admin' });
    expect(overview.enforcement.breakGlass).toEqual([
      expect.objectContaining({ id: ids.breakglass, username: 'breakglass', passwordSignIn: true, validAdmin: true, passkeys: 1, authenticatorApp: false }),
    ]);

    expect(overview.oidc).toEqual([
      expect.objectContaining({ id: 'corp-idp', host: 'auth.example.com', users: { total: 1, invited: 0, names: ['admin'] }, lastSignIn: { at: ago(1), user: 'admin' } }),
    ]);
    expect(overview.saml[0]).toMatchObject({ name: 'Entra ID', mappings: [{ group: 'ingressi-admins', role: 'Admin' }], lastSignIn: { at: ago(2), user: 'saml' } });
    expect(overview.ldap![0]).toMatchObject({
      name: 'Corp directory',
      transport: 'tls',
      open: true,
      health: { status: 'failing', consecutiveFailures: 17, lastError: 'Service account bind: invalid credentials (LDAP result 49)' },
      lastSignIn: { at: ago(5), user: 'corp' },
    });
    expect(overview.scim).toMatchObject({
      enabled: true,
      manageRoles: true,
      users: { total: 1, invited: 1 },
      mappings: [{ group: 'ingressi-users', role: 'User', priority: 1 }],
      tokens: { count: 1, latest: { name: 'Entra', prefix: 'scim_abc' } },
      lastChange: { at: ago(0) },
    });

    expect(overview.loginPage).toEqual([
      { kind: 'oidc', label: 'Continue with Corporate IdP', state: 'offered' },
      { kind: 'saml', label: 'Continue with Entra ID', state: 'offered' },
      { kind: 'ldap', label: 'Sign in with Corp directory', state: 'unavailable' },
      { kind: 'password', label: 'Break-glass sign-in', state: 'break_glass' },
      { kind: 'passkey', label: 'Sign in with a passkey', state: 'break_glass' },
    ]);
    expect(JSON.stringify(overview)).not.toMatch(/super-secret|client-id-value|bind-password|hash-1|api-hash/);
  });

  it('offers no password or passkey sign-in while enforced without a break-glass account', async () => {
    await ctx.db.update(schema.settings)
      .set({ value: JSON.stringify({ enabled: true, breakGlassUserIds: [] }) })
      .where(eq(schema.settings.key, 'sso_enforcement'));
    const overview = await getSignInOverview(adminAccess(ids.admin), NOW);
    expect(overview.enforcement).toMatchObject({ enabled: true, breakGlass: [], warnings: [] });
    expect(overview.loginPage.map((option) => option.kind)).toEqual(['oidc', 'saml', 'ldap']);
  });

  it('leaves out directories and SCIM for a role that cannot read them', async () => {
    const overview = await getSignInOverview(roleAccess(['sso:read']), NOW);
    expect(overview.ldap).toBeNull();
    expect(overview.scim).toBeNull();
    // The login page still shows what anyone sees there.
    expect(overview.loginPage.some((option) => option.kind === 'ldap')).toBe(true);
  });
});

describe('REST routes', () => {
  const request = (path: string) => new NextRequest(`http://localhost${path}`);

  it('guards each overview with its read permission and answers without caching', async () => {
    const users = await usersRoute.GET(request('/api/v1/users/overview'));
    const groups = await groupsRoute.GET(request('/api/v1/groups/overview'));
    const signIn = await signInRoute.GET(request('/api/v1/sign-in/overview'));
    expect(ctx.permissions).toEqual(['users:read', 'groups:read', 'sso:read']);
    for (const response of [users, groups, signIn]) {
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect((await users.json()).users.length).toBe(6);
    expect((await groups.json()).groups.length).toBe(2);
    expect((await signIn.json()).enforcement.enabled).toBe(true);
  });
});
