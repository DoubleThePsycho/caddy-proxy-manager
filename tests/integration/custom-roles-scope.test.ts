/**
 * Tag scopes of custom roles on proxy hosts, L4 hosts and certificates,
 * through the REST API (real API tokens and guards), the dashboard server
 * actions and the pages (real requirePermission with a mocked session), and
 * the limits on every non-administrator (raw Caddy JSON, the admin API port,
 * references the caller cannot read).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { apiRequest, idParams, insertRole, insertToken, insertUser, json, nowIso } from '../helpers/custom-roles';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb, sessionUserId: 0 }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('@/src/lib/auth', async (importOriginal) => importOriginal());
vi.mock('@/src/lib/auth-server', () => ({
  getAuth: () => ({
    api: { getSession: async () => ({ user: { id: ctx.sessionUserId }, session: { id: 1, createdAt: new Date() } }) },
  }),
  reloadOAuthProviders: async () => {},
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import * as hostsRoute from '@/app/api/v1/proxy-hosts/route';
import * as hostRoute from '@/app/api/v1/proxy-hosts/[id]/route';
import * as faRoute from '@/app/api/v1/proxy-hosts/[id]/forward-auth-access/route';
import * as rulesRoute from '@/app/api/v1/proxy-hosts/[id]/mtls-access-rules/route';
import * as l4sRoute from '@/app/api/v1/l4-proxy-hosts/route';
import * as l4Route from '@/app/api/v1/l4-proxy-hosts/[id]/route';
import * as certsRoute from '@/app/api/v1/certificates/route';
import * as certRoute from '@/app/api/v1/certificates/[id]/route';
import * as caRoute from '@/app/api/v1/ca-certificates/route';
import ProxyHostsPage from '@/app/(dashboard)/proxy-hosts/page';
import L4ProxyHostsPage from '@/app/(dashboard)/l4-proxy-hosts/page';
import {
  deleteProxyHostAction,
  toggleProxyHostAction,
  updateProxyHostAction,
  createProxyHostAction,
} from '@/app/(dashboard)/proxy-hosts/actions';
import { deleteL4ProxyHostAction } from '@/app/(dashboard)/l4-proxy-hosts/actions';
import { deleteCertificateAction } from '@/app/(dashboard)/certificates/actions';
import { createUserAction, deleteUserAction, updateUserRoleAction, updateUserStatusAction } from '@/app/(dashboard)/users/actions';
import { deleteRoleAction, saveRoleAction } from '@/ee/custom-roles/ui/actions';
import UsersPage from '@/app/(dashboard)/users/page';
import { installLicense, licenseSigner } from '../helpers/config-fixture';
import { setTrustedLicenseKeysForTests } from '@/ee/licensing/public-keys';
import { first } from '@/src/lib/db/ops';

const ADMIN = 1;
const TEAM_A = 2; // scoped to team-a
const OPERATOR = 3; // same permissions, no scope

let tokens: { admin: string; teamA: string; operator: string };
let hosts: { a: number; b: number; ab: number; untagged: number };
let l4: { a: number; b: number };
let certs: { a: number; b: number; shared: number };

async function host(name: string, domains: string[], tags: string[], certificateId: number | null = null) {
  const now = nowIso();
  return (await first(ctx.db.insert(schema.proxyHosts).values({
    name, domains: JSON.stringify(domains), upstreams: '["backend:8080"]', certificateId, tags: JSON.stringify(tags),
    createdAt: now, updatedAt: now,
  }).returning()))!.id;
}

async function l4Host(name: string, listenAddress: string, tags: string[]) {
  const now = nowIso();
  return (await first(ctx.db.insert(schema.l4ProxyHosts).values({
    name, protocol: 'tcp', listenAddress, upstreams: '["db:5432"]', tags: JSON.stringify(tags), createdAt: now, updatedAt: now,
  }).returning()))!.id;
}

async function certificate(name: string) {
  const now = nowIso();
  return (await first(ctx.db.insert(schema.certificates).values({
    name, type: 'managed', domainNames: '["x.example.com"]', createdAt: now, updatedAt: now,
  }).returning()))!.id;
}

async function storedTags(id: number): Promise<string[]> {
  return JSON.parse((await first(ctx.db.select().from(schema.proxyHosts).where(eq(schema.proxyHosts.id, id)).limit(1)))!.tags);
}

const PERMISSIONS = [
  'proxy_hosts:read', 'proxy_hosts:write', 'l4_proxy_hosts:read', 'l4_proxy_hosts:write',
  'certificates:read', 'certificates:write',
];

beforeEach(async () => {
  ctx.db = createTestDb();
  await insertRole(ctx.db, 1, PERMISSIONS, ['team-a'], 'Team A');
  await insertRole(ctx.db, 2, PERMISSIONS, [], 'Operators');
  await insertUser(ctx.db, ADMIN, 'admin');
  await insertUser(ctx.db, TEAM_A, 'viewer', 1);
  await insertUser(ctx.db, OPERATOR, 'viewer', 2);
  tokens = { admin: await insertToken(ctx.db, ADMIN), teamA: await insertToken(ctx.db, TEAM_A), operator: await insertToken(ctx.db, OPERATOR) };
  certs = { a: await certificate('A cert'), b: await certificate('B cert'), shared: await certificate('Shared cert') };
  hosts = {
    a: await host('A', ['a.example.com'], ['team-a'], certs.a),
    b: await host('B', ['b.example.com'], ['team-b'], certs.b),
    ab: await host('AB', ['ab.example.com'], ['team-a', 'team-b'], certs.shared),
    untagged: await host('Untagged', ['u.example.com'], [], certs.shared),
  };
  l4 = { a: await l4Host('A db', ':5432', ['team-a']), b: await l4Host('B db', ':6432', ['team-b']) };
});

const newHost = (extra: object = {}) => ({ name: 'New', domains: ['new.example.com'], upstreams: ['backend:80'], ...extra });

describe('proxy hosts', () => {
  it('lists only the hosts with one of the role\'s tags', async () => {
    const list = await json(await hostsRoute.GET(apiRequest('GET', '/api/v1/proxy-hosts', tokens.teamA)));
    expect(list.map((h: { name: string }) => h.name).sort()).toEqual(['A', 'AB']);
    const all = await json(await hostsRoute.GET(apiRequest('GET', '/api/v1/proxy-hosts', tokens.operator)));
    expect(all).toHaveLength(4);
    expect(all.find((h: { name: string }) => h.name === 'AB').tags).toEqual(['team-a', 'team-b']);
  });

  it('answers 404 for a host outside the scope, as for a missing one', async () => {
    expect((await hostRoute.GET(apiRequest('GET', '/x', tokens.teamA), idParams(hosts.b))).status).toBe(404);
    expect((await hostRoute.GET(apiRequest('GET', '/x', tokens.teamA), idParams(hosts.untagged))).status).toBe(404);
    expect((await hostRoute.GET(apiRequest('GET', '/x', tokens.teamA), idParams(hosts.a))).status).toBe(200);
    expect((await hostRoute.PUT(apiRequest('PUT', '/x', tokens.teamA, { name: 'Taken' }), idParams(hosts.b))).status).toBe(404);
    expect((await hostRoute.DELETE(apiRequest('DELETE', '/x', tokens.teamA), idParams(hosts.b))).status).toBe(404);
    expect((await faRoute.GET(apiRequest('GET', '/x', tokens.teamA), idParams(hosts.b))).status).toBe(404);
    expect((await rulesRoute.GET(apiRequest('GET', '/x', tokens.teamA), idParams(hosts.b))).status).toBe(404);
    expect((await first(ctx.db.select().from(schema.proxyHosts).where(eq(schema.proxyHosts.id, hosts.b)).limit(1)))!.name).toBe('B');
    // In scope: works.
    expect((await hostRoute.DELETE(apiRequest('DELETE', '/x', tokens.teamA), idParams(hosts.a))).status).toBe(200);
  });

  it('needs one of the role\'s tags to create a host, and only the role\'s tags', async () => {
    const missing = await hostsRoute.POST(apiRequest('POST', '/x', tokens.teamA, newHost()));
    expect(missing.status).toBe(400);
    expect((await json(missing)).error).toMatch(/at least one of your role's tags: team-a/);
    expect((await hostsRoute.POST(apiRequest('POST', '/x', tokens.teamA, newHost({ tags: ['team-b'] })))).status).toBe(403);
    expect((await hostsRoute.POST(apiRequest('POST', '/x', tokens.teamA, newHost({ tags: ['team-a', 'prod'] })))).status).toBe(403);
    const created = await hostsRoute.POST(apiRequest('POST', '/x', tokens.teamA, newHost({ tags: ['Team-A'] })));
    expect(created.status).toBe(201);
    expect((await json(created)).tags).toEqual(['team-a']);
    // Without a scope, tags are free.
    const free = await hostsRoute.POST(apiRequest('POST', '/x', tokens.operator, newHost({ domains: ['free.example.com'], tags: ['prod', 'eu'] })));
    expect(free.status).toBe(201);
    expect((await json(free)).tags).toEqual(['eu', 'prod']);
  });

  it('keeps tags outside the scope and refuses taking the last scope tag away', async () => {
    const response = await hostRoute.PUT(apiRequest('PUT', '/x', tokens.teamA, { tags: ['team-a'] }), idParams(hosts.ab));
    expect(response.status).toBe(200);
    expect(await storedTags(hosts.ab)).toEqual(['team-a', 'team-b']);
    expect((await hostRoute.PUT(apiRequest('PUT', '/x', tokens.teamA, { tags: [] }), idParams(hosts.a))).status).toBe(400);
    expect(await storedTags(hosts.a)).toEqual(['team-a']);
    // Other changes leave the tags alone.
    expect((await hostRoute.PUT(apiRequest('PUT', '/x', tokens.teamA, { name: 'Renamed' }), idParams(hosts.a))).status).toBe(200);
    expect(await storedTags(hosts.a)).toEqual(['team-a']);
  });

  it('refuses domains served by a host outside the scope, wildcards included', async () => {
    for (const domains of [['b.example.com'], ['*.example.com'], ['u.example.com']]) {
      const response = await hostsRoute.POST(apiRequest('POST', '/x', tokens.teamA, newHost({ domains, tags: ['team-a'] })));
      expect(response.status, domains.join()).toBe(403);
      expect((await json(response)).error).toMatch(/outside your role's scope/);
    }
    expect((await hostRoute.PUT(apiRequest('PUT', '/x', tokens.teamA, { domains: ['b.example.com'] }), idParams(hosts.a))).status).toBe(403);
    // A domain of an in-scope host is the team's own business.
    expect((await hostsRoute.POST(apiRequest('POST', '/x', tokens.teamA, newHost({ domains: ['ab.example.com'], tags: ['team-a'] })))).status).toBe(201);
  });

  it('refuses raw Caddy JSON and the admin API port to every non-administrator', async () => {
    for (const token of [tokens.teamA, tokens.operator]) {
      const json1 = await hostsRoute.POST(apiRequest('POST', '/x', token, newHost({ tags: ['team-a'], customReverseProxyJson: '{"handler":"static_response"}' })));
      expect(json1.status).toBe(403);
      const port = await hostsRoute.POST(apiRequest('POST', '/x', token, newHost({ tags: ['team-a'], upstreams: ['http://caddy:2019'] })));
      expect(port.status).toBe(403);
      expect((await json(port)).error).toMatch(/port 2019/);
      const location = await hostsRoute.POST(apiRequest('POST', '/x', token, newHost({
        tags: ['team-a'], locationRules: [{ path: '/api/*', upstreams: ['localhost:2019'] }],
      })));
      expect(location.status).toBe(403);
    }
    const admin = await hostsRoute.POST(apiRequest('POST', '/x', tokens.admin, newHost({ customReverseProxyJson: '{"headers":{}}' })));
    expect(admin.status).toBe(201);
  });

  it('refuses referencing a certificate outside the role\'s certificate scope', async () => {
    expect((await hostRoute.PUT(apiRequest('PUT', '/x', tokens.teamA, { certificateId: certs.b }), idParams(hosts.a))).status).toBe(403);
    expect((await hostRoute.PUT(apiRequest('PUT', '/x', tokens.teamA, { certificateId: certs.shared }), idParams(hosts.a))).status).toBe(200);
    // Keeping the current certificate is always fine.
    expect((await hostRoute.PUT(apiRequest('PUT', '/x', tokens.teamA, { certificateId: certs.shared, name: 'Same' }), idParams(hosts.a))).status).toBe(200);
  });
});

describe('L4 proxy hosts', () => {
  it('lists, reads and changes only in-scope hosts', async () => {
    const list = await json(await l4sRoute.GET(apiRequest('GET', '/x', tokens.teamA)));
    expect(list.map((h: { name: string }) => h.name)).toEqual(['A db']);
    expect((await l4Route.GET(apiRequest('GET', '/x', tokens.teamA), idParams(l4.b))).status).toBe(404);
    expect((await l4Route.DELETE(apiRequest('DELETE', '/x', tokens.teamA), idParams(l4.b))).status).toBe(404);
    expect((await l4Route.PUT(apiRequest('PUT', '/x', tokens.teamA, { name: 'Mine' }), idParams(l4.a))).status).toBe(200);
  });

  it('needs a scope tag to create and refuses ports used outside the scope', async () => {
    const body = (extra: object) => ({ name: 'Redis', protocol: 'tcp', listenAddress: ':6379', upstreams: ['redis:6379'], ...extra });
    expect((await l4sRoute.POST(apiRequest('POST', '/x', tokens.teamA, body({})))).status).toBe(400);
    expect((await l4sRoute.POST(apiRequest('POST', '/x', tokens.teamA, body({ tags: ['team-a'], listenAddress: ':6432' })))).status).toBe(403);
    expect((await l4sRoute.POST(apiRequest('POST', '/x', tokens.teamA, body({ tags: ['team-a'], upstreams: ['caddy:2019'] })))).status).toBe(403);
    const created = await l4sRoute.POST(apiRequest('POST', '/x', tokens.teamA, body({ tags: ['team-a'] })));
    expect(created.status).toBe(201);
    expect((await json(created)).tags).toEqual(['team-a']);
    expect((await l4Route.PUT(apiRequest('PUT', '/x', tokens.teamA, { listenAddress: ':6432' }), idParams(l4.a))).status).toBe(403);
  });
});

describe('certificates', () => {
  it('shows a scoped role the certificates its hosts use', async () => {
    const list = await json(await certsRoute.GET(apiRequest('GET', '/x', tokens.teamA)));
    expect(list.map((c: { name: string }) => c.name).sort()).toEqual(['A cert', 'Shared cert']);
    expect((await certRoute.GET(apiRequest('GET', '/x', tokens.teamA), idParams(certs.b))).status).toBe(404);
    expect((await certRoute.GET(apiRequest('GET', '/x', tokens.teamA), idParams(certs.a))).status).toBe(200);
    expect(await json(await certsRoute.GET(apiRequest('GET', '/x', tokens.operator)))).toHaveLength(3);
  });

  it('changes or deletes a certificate only when every host using it is in scope', async () => {
    expect((await certRoute.PUT(apiRequest('PUT', '/x', tokens.teamA, { name: 'Ours' }), idParams(certs.shared))).status).toBe(403);
    expect((await certRoute.DELETE(apiRequest('DELETE', '/x', tokens.teamA), idParams(certs.shared))).status).toBe(403);
    expect((await certRoute.DELETE(apiRequest('DELETE', '/x', tokens.teamA), idParams(certs.b))).status).toBe(404);
    expect((await certRoute.PUT(apiRequest('PUT', '/x', tokens.teamA, { name: 'Ours' }), idParams(certs.a))).status).toBe(200);
  });

  it('cannot create certificates or reach CA certificates under a scope', async () => {
    const created = await certsRoute.POST(apiRequest('POST', '/x', tokens.teamA, { name: 'New', type: 'managed', domainNames: ['n.example.com'] }));
    expect(created.status).toBe(403);
    expect((await caRoute.GET(apiRequest('GET', '/x', tokens.teamA))).status).toBe(403);
    expect((await caRoute.GET(apiRequest('GET', '/x', tokens.operator))).status).toBe(200);
  });
});

describe('dashboard pages and actions', () => {
  const pageArgs = { searchParams: Promise.resolve({}) };

  it('lists only in-scope hosts on the pages', async () => {
    ctx.sessionUserId = TEAM_A;
    const page = await ProxyHostsPage(pageArgs) as { props: { hosts: Array<{ name: string }>; pagination: { total: number }; scopeTags: string[]; certificates: Array<{ name: string }> } };
    expect(page.props.hosts.map((h) => h.name).sort()).toEqual(['A', 'AB']);
    expect(page.props.pagination.total).toBe(2);
    expect(page.props.scopeTags).toEqual(['team-a']);
    expect(page.props.certificates.map((c) => c.name).sort()).toEqual(['A cert', 'Shared cert']);
    const l4Page = await L4ProxyHostsPage(pageArgs) as { props: { hosts: Array<{ name: string }> } };
    expect(l4Page.props.hosts.map((h) => h.name)).toEqual(['A db']);

    ctx.sessionUserId = ADMIN;
    const adminPage = await ProxyHostsPage(pageArgs) as { props: { hosts: unknown[] } };
    expect(adminPage.props.hosts).toHaveLength(4);
  });

  it('refuses actions on hosts outside the scope', async () => {
    ctx.sessionUserId = TEAM_A;
    const form = new FormData();
    form.set('name', 'Taken');
    expect(await updateProxyHostAction(hosts.b, undefined, form)).toMatchObject({ status: 'error', message: 'Proxy host not found' });
    expect(await deleteProxyHostAction(hosts.b)).toMatchObject({ status: 'error', message: 'Proxy host not found' });
    expect(await toggleProxyHostAction(hosts.b, false)).toMatchObject({ status: 'error' });
    expect(await deleteL4ProxyHostAction(l4.b)).toMatchObject({ status: 'error', message: 'L4 proxy host not found' });
    await expect(deleteCertificateAction(certs.shared)).rejects.toThrow(/outside your role's scope/);
    expect((await first(ctx.db.select().from(schema.proxyHosts).where(eq(schema.proxyHosts.id, hosts.b)).limit(1)))!.enabled).toBe(true);
  });

  it('creates a host from the form only with a scope tag', async () => {
    ctx.sessionUserId = TEAM_A;
    const form = new FormData();
    form.set('name', 'From form');
    form.set('domains', 'form.example.com');
    form.set('upstreams', 'backend:8080');
    expect(await createProxyHostAction(undefined, form)).toMatchObject({ status: 'error', message: expect.stringMatching(/team-a/) });
    form.set('tags', 'team-a');
    expect(await createProxyHostAction(undefined, form)).toMatchObject({ status: 'success' });
    const created = (await first(ctx.db.select().from(schema.proxyHosts).where(eq(schema.proxyHosts.name, 'From form')).limit(1)))!;
    expect(JSON.parse(created.tags)).toEqual(['team-a']);
  });
});

afterAll(() => setTrustedLicenseKeysForTests(null));

describe('role management from the dashboard', () => {
  const MANAGER = 7;
  const MEMBER = 8;

  beforeEach(async () => {
    setTrustedLicenseKeysForTests(licenseSigner.keys);
    await insertRole(ctx.db, 3, ['users:read', 'users:write', 'proxy_hosts:read'], [], 'Managers');
    await insertUser(ctx.db, MANAGER, 'viewer', 3);
    await insertUser(ctx.db, MEMBER, 'user');
  });

  it('assigns a custom role with the license, takes it away without one', async () => {
    ctx.sessionUserId = ADMIN;
    expect(await updateUserRoleAction(MEMBER, 'custom:2')).toMatchObject({ ok: false, error: expect.stringMatching(/Custom roles needs/) });
    await installLicense(ctx.db, 'business');
    expect(await updateUserRoleAction(MEMBER, 'custom:2')).toEqual({ ok: true });
    expect(await first(ctx.db.select().from(schema.users).where(eq(schema.users.id, MEMBER)).limit(1))).toMatchObject({ role: 'viewer', customRoleId: 2 });
    await ctx.db.delete(schema.settings).where(eq(schema.settings.key, 'license'));
    expect(await updateUserRoleAction(MEMBER, 'user')).toEqual({ ok: true });
    expect(await updateUserRoleAction(MEMBER, 'custom:abc')).toEqual({ ok: false, error: 'Invalid role' });
  });

  it('keeps a manager to the roles and users they cover', async () => {
    await installLicense(ctx.db, 'business');
    ctx.sessionUserId = MANAGER;
    expect(await updateUserRoleAction(MEMBER, 'admin')).toMatchObject({ ok: false });
    expect(await updateUserRoleAction(MEMBER, 'custom:1')).toMatchObject({ ok: false, error: expect.stringMatching(/only grant/) });
    expect(await updateUserStatusAction(ADMIN, 'disabled')).toMatchObject({ ok: false, error: expect.stringMatching(/cannot manage/) });
    expect(await deleteUserAction(ADMIN)).toMatchObject({ ok: false });
    expect(await updateUserRoleAction(MANAGER, 'user')).toEqual({ ok: false, error: 'Cannot change your own role' });
    const form = new FormData();
    form.set('email', 'new@example.com');
    form.set('password', 'Correct-Horse-9!');
    form.set('role', 'admin');
    expect(await createUserAction(form)).toMatchObject({ ok: false });
    form.set('role', 'viewer');
    expect(await createUserAction(form)).toEqual({ ok: true });
    expect(await first(ctx.db.select().from(schema.users).where(eq(schema.users.id, ADMIN)).limit(1))).toMatchObject({ role: 'admin', status: 'active' });
  });

  it('saves roles with the license and deletes them without one', async () => {
    ctx.sessionUserId = ADMIN;
    expect(await saveRoleAction(null, { name: 'Auditors', permissions: ['audit_log:read'] })).toMatchObject({ ok: false });
    await installLicense(ctx.db, 'business');
    expect(await saveRoleAction(null, { name: 'Auditors', permissions: ['audit_log:read'] })).toEqual({ ok: true });
    const role = (await first(ctx.db.select().from(schema.customRoles).where(eq(schema.customRoles.name, 'Auditors')).limit(1)))!;
    expect(await saveRoleAction(role.id, { description: 'Read the log' })).toEqual({ ok: true });
    await ctx.db.delete(schema.settings).where(eq(schema.settings.key, 'license'));
    expect(await deleteRoleAction(role.id)).toEqual({ ok: true });
    expect(await first(ctx.db.select().from(schema.customRoles).where(eq(schema.customRoles.id, role.id)).limit(1))).toBeUndefined();
  });

  it('gives the Users page the roles and the picker', async () => {
    await installLicense(ctx.db, 'business');
    ctx.sessionUserId = MANAGER;
    const page = await UsersPage() as { props: { customRoles: Array<{ name: string }>; canWrite: boolean; canAssignAdmin: boolean; mfaPolicy: unknown; customRolesLicensed: boolean } };
    expect(page.props.customRoles.map((role) => role.name).sort()).toEqual(['Managers', 'Operators', 'Team A']);
    expect(page.props).toMatchObject({ canWrite: true, canAssignAdmin: false, mfaPolicy: null, customRolesLicensed: true });
  });
});
