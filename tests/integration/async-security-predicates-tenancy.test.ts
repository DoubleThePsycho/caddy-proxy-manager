/**
 * Multi-tenancy (ee/multi-tenancy) security predicates that became
 * asynchronous, driven through their call sites in both directions:
 *
 *  - isOrganizationEnabled: auth() (src/lib/auth.ts), validateToken
 *    (src/lib/models/api-tokens.ts) and accessForUser (ee/custom-roles/access.ts);
 *  - isUserOrganizationBlocked: the forward-auth portal login
 *    (app/api/forward-auth/login/route.ts); the Better Auth session hook is in
 *    tests/unit/async-security-predicates-session-hook.test.ts;
 *  - assertActorReaches: the model layer refuses an organisation user on
 *    another organisation's row (404), whatever route called it;
 *  - readOrganization: an unknown organisation is refused by the
 *    organisation routes, by moves and by new rows (organizationForNewRow);
 *  - isProtectedUser (ee/scim/store.ts) as moves use it.
 *
 * An un-awaited Promise is truthy: `!isOrganizationEnabled(…)` would admit a
 * disabled organisation, `!await`-less `isUserOrganizationBlocked(…)` would
 * refuse everybody, and an un-awaited assertActorReaches would let the write
 * through (its rejection lost). The organisation flag is flipped directly in
 * the database, so nothing else (ended sessions, revoked grants) explains
 * the outcome.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { apiRequest, idParams, json, nowIso } from '../helpers/custom-roles';
import { installLicense, licenseSigner } from '../helpers/config-fixture';
import {
  A_ADMIN,
  A_USER,
  B_ADMIN,
  ORG_A,
  ORG_B,
  PROVIDER_ADMIN,
  PROVIDER_USER,
  insertOrganization,
  seedTenants,
  type TenantRows,
  type TenantTokens,
} from '../helpers/multi-tenancy';

const ctx = vi.hoisted(() => {
  // Vite exposes BASE_URL="/" to tests; the portal routes need an absolute origin.
  process.env.BASE_URL = 'http://localhost:3000';
  return { db: null as unknown as TestDb, sessionUserId: 0 };
});

vi.mock('@/src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
// The real auth(), instead of the setup file's mock.
vi.mock('@/src/lib/auth', async (importOriginal) => importOriginal());
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
vi.mock('@/src/lib/caddy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/caddy')>()),
  applyCaddyConfig: vi.fn(async () => undefined),
}));

import { setTrustedLicenseKeysForTests } from '@/ee/licensing/public-keys';
import { deleteProxyHost } from '@/src/lib/models/proxy-hosts';
import { deleteGroup } from '@/src/lib/models/groups';
import { deleteAccessList } from '@/src/lib/models/access-lists';
import { createRedirectIntent, setForwardAuthAccess } from '@/src/lib/models/forward-auth';
import { validateToken } from '@/src/lib/models/api-tokens';
import { auth } from '@/src/lib/auth';
import { can } from '@/src/lib/permissions';
import { accessForUser } from '@/ee/custom-roles/access';
import { isOrganizationEnabled, isUserOrganizationBlocked } from '@/ee/multi-tenancy/store';
import { isProtectedUser } from '@/ee/scim/store';
import { writeSsoEnforcement } from '@/ee/sso/enforcement-store';
import * as organizationRoute from '@/app/api/v1/organizations/[id]/route';
import * as membersRoute from '@/app/api/v1/organizations/[id]/members/route';
import * as moveRoute from '@/app/api/v1/organizations/move/route';
import * as hostsRoute from '@/app/api/v1/proxy-hosts/route';
import { POST as portalLogin } from '@/app/api/forward-auth/login/route';
import { first } from '@/src/lib/db/ops';

const UNKNOWN_ORG = 99;

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

async function setOrganizationEnabled(id: number, enabled: boolean) {
  await ctx.db.update(schema.organizations).set({ enabled }).where(eq(schema.organizations.id, id));
}

/** The row `id` of a table with an id and an organizationId, or undefined. */
async function row(
  table: typeof schema.proxyHosts | typeof schema.groups | typeof schema.accessLists | typeof schema.users,
  id: number
): Promise<{ id: number; organizationId: number | null } | undefined> {
  const anyTable = table as any;
  return await first(ctx.db.select({ id: anyTable.id, organizationId: anyTable.organizationId }).from(anyTable).where(eq(anyTable.id, id)).limit(1));
}

describe('isOrganizationEnabled', () => {
  it('returns a real boolean', async () => {
    expect(await isOrganizationEnabled(ctx.db, ORG_A)).toBe(true);
    await setOrganizationEnabled(ORG_A, false);
    expect(await isOrganizationEnabled(ctx.db, ORG_A)).toBe(false);
    expect(await isOrganizationEnabled(ctx.db, UNKNOWN_ORG)).toBe(false);
  });

  it('auth(): a session of a disabled organisation\'s user is null, others keep theirs', async () => {
    ctx.sessionUserId = A_ADMIN;
    expect(await auth()).toMatchObject({ user: { id: String(A_ADMIN), organizationId: ORG_A } });
    await setOrganizationEnabled(ORG_A, false);
    expect(await auth()).toBeNull();
    ctx.sessionUserId = B_ADMIN;
    expect(await auth()).toMatchObject({ user: { id: String(B_ADMIN) } });
    ctx.sessionUserId = PROVIDER_ADMIN;
    expect(await auth()).toMatchObject({ user: { id: String(PROVIDER_ADMIN) } });
  });

  it('validateToken(): a disabled organisation\'s tokens authenticate as nobody, others still work', async () => {
    expect(await validateToken(tokens.aAdmin)).toMatchObject({ user: { id: A_ADMIN, organizationId: ORG_A } });
    await setOrganizationEnabled(ORG_A, false);
    expect(await validateToken(tokens.aAdmin)).toBeNull();
    expect(await validateToken(tokens.bAdmin)).toMatchObject({ user: { id: B_ADMIN } });
    await setOrganizationEnabled(ORG_A, true);
    expect(await validateToken(tokens.aAdmin)).not.toBeNull();
  });

  it('accessForUser(): a disabled organisation\'s administrator holds nothing', async () => {
    const access = () => accessForUser({ id: A_ADMIN, role: 'org_admin', customRoleId: null, organizationId: ORG_A });
    expect(can(await access(), 'proxy_hosts:write')).toBe(true);
    await setOrganizationEnabled(ORG_A, false);
    const disabled = await access();
    expect(can(disabled, 'proxy_hosts:write')).toBe(false);
    expect(disabled.permissions.size).toBe(0);
    // Read from the database when the caller does not pass it.
    expect((await accessForUser({ id: A_ADMIN, role: 'org_admin', customRoleId: null })).permissions.size).toBe(0);
  });
});

describe('isUserOrganizationBlocked: forward-auth portal login', () => {
  const PASSWORD = 'Correct-Horse-9!';
  const PORTAL_USER = 30;
  let portalHostId = 0;
  let clientCounter = 0;

  beforeEach(async () => {
    const now = nowIso();
    await ctx.db.insert(schema.users).values({
      id: PORTAL_USER, email: 'portal-alpha@localhost', name: 'portal-alpha', passwordHash: bcrypt.hashSync(PASSWORD, 4),
      role: 'user', organizationId: ORG_A, provider: 'credentials', subject: 'portal-alpha', status: 'active',
      createdAt: now, updatedAt: now,
    });
    const [host] = await ctx.db.insert(schema.proxyHosts).values({
      name: 'Alpha portal', domains: JSON.stringify(['portal.alpha.example.com']), upstreams: JSON.stringify(['10.1.0.7:8080']),
      organizationId: ORG_A, enabled: true, meta: JSON.stringify({ cpm_forward_auth: { enabled: true } }),
      createdAt: now, updatedAt: now,
    }).returning();
    portalHostId = host.id;
    await ctx.db.insert(schema.forwardAuthAccess).values({ proxyHostId: portalHostId, userId: PORTAL_USER, createdAt: now });
  });

  async function login() {
    clientCounter += 1;
    const rid = await createRedirectIntent('https://portal.alpha.example.com/');
    return portalLogin(new NextRequest('http://localhost:3000/api/forward-auth/login', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000', 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${clientCounter}` },
      body: JSON.stringify({ username: 'portal-alpha', password: PASSWORD, rid }),
    }));
  }

  async function portalSessions() {
    return await ctx.db.select().from(schema.forwardAuthSessions).where(eq(schema.forwardAuthSessions.userId, PORTAL_USER));
  }

  it('returns a real boolean', async () => {
    expect(await isUserOrganizationBlocked(ctx.db, PORTAL_USER)).toBe(false);
    expect(await isUserOrganizationBlocked(ctx.db, PROVIDER_USER)).toBe(false);
    await setOrganizationEnabled(ORG_A, false);
    expect(await isUserOrganizationBlocked(ctx.db, PORTAL_USER)).toBe(true);
  });

  // Regression shape: `!isUserOrganizationBlocked(…)` without await is always
  // false, so every portal login would be refused.
  it('signs in a user of an enabled organisation', async () => {
    const response = await login();
    expect(response.status).toBe(200);
    expect((await json(response)).redirectTo).toMatch(/^https:\/\/portal\.alpha\.example\.com\//);
    expect(await portalSessions()).toHaveLength(1);
  });

  it('refuses a user of a disabled organisation like a wrong password, and creates no session', async () => {
    await setOrganizationEnabled(ORG_A, false);
    const response = await login();
    expect(response.status).toBe(401);
    expect(await json(response)).toEqual({ error: 'Invalid credentials' });
    expect(await portalSessions()).toEqual([]);
  });
});

describe('assertActorReaches: the model layer refuses rows of another organisation', () => {
  it('proxy hosts (deleteProxyHost)', async () => {
    await expect(deleteProxyHost(rows.hosts.b, A_ADMIN)).rejects.toMatchObject({ status: 404 });
    await expect(deleteProxyHost(rows.hosts.p, A_ADMIN)).rejects.toMatchObject({ status: 404 });
    expect(await row(schema.proxyHosts, rows.hosts.b)).toBeDefined();
    expect(await row(schema.proxyHosts, rows.hosts.p)).toBeDefined();

    await deleteProxyHost(rows.hosts.a, A_ADMIN);
    expect(await row(schema.proxyHosts, rows.hosts.a)).toBeUndefined();
    // The provider level reaches every organisation.
    await deleteProxyHost(rows.hosts.b, PROVIDER_ADMIN);
    expect(await row(schema.proxyHosts, rows.hosts.b)).toBeUndefined();
  });

  it('groups (deleteGroup)', async () => {
    await expect(deleteGroup(rows.groups.b, A_ADMIN)).rejects.toMatchObject({ status: 404 });
    expect(await row(schema.groups, rows.groups.b)).toBeDefined();
    await deleteGroup(rows.groups.a, A_ADMIN);
    expect(await row(schema.groups, rows.groups.a)).toBeUndefined();
  });

  it('access lists (deleteAccessList)', async () => {
    await expect(deleteAccessList(rows.lists.b, A_ADMIN)).rejects.toMatchObject({ status: 404 });
    expect(await row(schema.accessLists, rows.lists.b)).toBeDefined();
    await deleteAccessList(rows.lists.a, A_ADMIN);
    expect(await row(schema.accessLists, rows.lists.a)).toBeUndefined();
  });

  it('forward-auth grants (setForwardAuthAccess)', async () => {
    const grants = (hostId: number) =>
      ctx.db.select().from(schema.forwardAuthAccess).where(eq(schema.forwardAuthAccess.proxyHostId, hostId));
    const bravoGrants = await grants(rows.hosts.b);
    await expect(setForwardAuthAccess(rows.hosts.b, { userIds: [] }, A_ADMIN)).rejects.toMatchObject({ status: 404 });
    expect(await grants(rows.hosts.b)).toEqual(bravoGrants);

    await setForwardAuthAccess(rows.hosts.a, { userIds: [A_USER] }, A_ADMIN);
    expect((await grants(rows.hosts.a)).map((grant) => grant.userId)).toEqual([A_USER]);
  });
});

describe('readOrganization: an unknown organisation is refused', () => {
  const provider = (method: string, payload?: unknown) => apiRequest(method, '/x', tokens.provider, payload);

  it('by the organisation routes, which still serve existing organisations', async () => {
    expect((await organizationRoute.GET(provider('GET'), idParams(UNKNOWN_ORG))).status).toBe(404);
    expect((await organizationRoute.PATCH(provider('PATCH', { notes: 'Reviewed' }), idParams(UNKNOWN_ORG))).status).toBe(404);
    expect((await organizationRoute.DELETE(provider('DELETE'), idParams(UNKNOWN_ORG))).status).toBe(404);
    expect((await membersRoute.GET(provider('GET'), idParams(UNKNOWN_ORG))).status).toBe(404);

    const found = await organizationRoute.GET(provider('GET'), idParams(ORG_A));
    expect(found.status).toBe(200);
    expect(await json(found)).toMatchObject({ id: ORG_A, name: 'Alpha' });
    const patched = await organizationRoute.PATCH(provider('PATCH', { notes: 'Reviewed' }), idParams(ORG_B));
    expect(patched.status).toBe(200);
    expect(await json(patched)).toMatchObject({ id: ORG_B, notes: 'Reviewed' });
    const members = await membersRoute.GET(provider('GET'), idParams(ORG_A));
    expect(members.status).toBe(200);
    expect((await json(members)).map((member: { id: number }) => member.id)).toContain(A_ADMIN);
    await insertOrganization(ctx.db, 9, 'Empty');
    expect((await organizationRoute.DELETE(provider('DELETE'), idParams(9))).status).toBe(204);
  });

  it('by moves (moveResources), which still move rows into an existing organisation', async () => {
    const refused = await moveRoute.POST(provider('POST', { organizationId: UNKNOWN_ORG, groupIds: [rows.groups.p] }));
    expect(refused.status).toBe(404);
    expect((await row(schema.groups, rows.groups.p))!.organizationId).toBeNull();

    const moved = await moveRoute.POST(provider('POST', { organizationId: ORG_B, groupIds: [rows.groups.p] }));
    expect(moved.status).toBe(200);
    expect((await row(schema.groups, rows.groups.p))!.organizationId).toBe(ORG_B);
  });

  it('by new rows (organizationForNewRow), which still go into an existing organisation', async () => {
    const host = (organizationId: number, name: string) => ({
      name, domains: [`${name.toLowerCase()}.bravo.example.com`], upstreams: ['10.9.0.1:8080'], organizationId,
    });
    const refused = await hostsRoute.POST(provider('POST', host(UNKNOWN_ORG, 'Ghost')));
    expect(refused.status).toBe(400);
    expect((await json(refused)).error).toBe('Unknown organisation');
    expect(await first(ctx.db.select().from(schema.proxyHosts).where(eq(schema.proxyHosts.name, 'Ghost')).limit(1))).toBeUndefined();

    const created = await hostsRoute.POST(provider('POST', host(ORG_B, 'Placed')));
    expect(created.status).toBe(201);
    expect((await json(created)).organizationId).toBe(ORG_B);
  });
});

describe('isProtectedUser: protected accounts never move', () => {
  it('returns a real boolean', async () => {
    expect(await isProtectedUser(ctx.db, PROVIDER_ADMIN)).toBe(true);
    expect(await isProtectedUser(ctx.db, PROVIDER_USER)).toBe(false);
    await writeSsoEnforcement(ctx.db, { enabled: false, breakGlassUserIds: [PROVIDER_USER] });
    expect(await isProtectedUser(ctx.db, PROVIDER_USER)).toBe(true);
  });

  // Regression shape: `if (isProtectedUser(…))` without await refuses every
  // move of a user; a predicate that never matches lets a break-glass account
  // be moved into an organisation (and lose its provider-level access).
  it('refuses moving a break-glass account and moves any other user', async () => {
    const move = () => moveRoute.POST(apiRequest('POST', '/x', tokens.provider, { organizationId: ORG_A, userIds: [PROVIDER_USER] }));
    await writeSsoEnforcement(ctx.db, { enabled: false, breakGlassUserIds: [PROVIDER_USER] });
    const refused = await move();
    expect(refused.status).toBe(400);
    expect((await json(refused)).error).toMatch(/break-glass account and cannot be moved/);
    expect((await row(schema.users, PROVIDER_USER))!.organizationId).toBeNull();

    await writeSsoEnforcement(ctx.db, { enabled: false, breakGlassUserIds: [] });
    expect((await move()).status).toBe(200);
    expect((await row(schema.users, PROVIDER_USER))!.organizationId).toBe(ORG_A);
  });
});
