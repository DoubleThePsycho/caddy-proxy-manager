/**
 * The multi-tenancy isolation matrix (ee/multi-tenancy): two organisations
 * (ALPHA, BRAVO) and the provider level. A user of ALPHA attacks every
 * resource type of BRAVO and of the provider level, with every operation,
 * through every surface (REST with a real API token and the real guards,
 * dashboard server actions and pages with a real session lookup, exports):
 * each attempt answers 404 (or 403 where the resource type is provider-level
 * altogether), nothing of BRAVO changes, and no response carries BRAVO's or the
 * provider's data. Every REST call site whose permission organisation users
 * cannot hold is swept with an ALPHA user whose custom role holds every
 * permission.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { apiRequest, idParams, json } from '../helpers/custom-roles';
import { installLicense, licenseSigner } from '../helpers/config-fixture';
import {
  A_ADMIN,
  A_EVERYTHING,
  A_USER,
  B_ADMIN,
  B_USER,
  ORG_A,
  ORG_B,
  PROVIDER_ADMIN,
  PROVIDER_USER,
  leaks,
  seedTenants,
  snapshotOutsideAlpha,
  type TenantRows,
  type TenantTokens,
} from '../helpers/multi-tenancy';
import { findPermissionCallSites, type CallSite } from '../helpers/permission-call-sites';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  sessionUserId: 0,
  viewCookie: undefined as string | undefined,
  seenHosts: [] as string[],
  queriedHosts: [] as string[][],
  /** Queries the /api/v1/analytics routes sent to ClickHouse. */
  analyticsQueries: [] as { query: string; query_params: Record<string, unknown> }[],
}));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('@/src/lib/auth-server', () => ({
  getAuth: () => ({
    api: { getSession: async () => ({ user: { id: ctx.sessionUserId }, session: { id: 1, createdAt: new Date() } }) },
  }),
  reloadOAuthProviders: async () => {},
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (name === 'organization_view' && ctx.viewCookie !== undefined ? { name, value: ctx.viewCookie } : undefined),
    set: () => {},
  }),
}));
vi.mock('@/src/lib/auth', async (importOriginal) => importOriginal());
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../../src/lib/caddy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/caddy')>()),
  applyCaddyConfig: vi.fn(async () => undefined),
}));
vi.mock('@clickhouse/client', () => {
  const unavailable = async () => { throw new Error('ClickHouse is not available in tests'); };
  return { createClient: () => ({ query: unavailable, insert: unavailable, command: unavailable, exec: unavailable, ping: unavailable, close: async () => {} }) };
});
vi.mock('../../src/lib/clickhouse/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/lib/clickhouse/client')>();
  const record = (hosts: string[]) => { ctx.queriedHosts.push([...hosts]); };
  return {
    ...original,
    isAnalyticsEnabled: () => true,
    queryDistinctHostsAll: async () => [...ctx.seenHosts],
    // The /api/v1/analytics routes query through getClient(); no rows come back.
    getClient: () => ({
      query: async (args: { query: string; query_params: Record<string, unknown> }) => {
        ctx.analyticsQueries.push(args);
        return { json: async () => [] };
      },
    }),
    querySummary: async (_from: number, _to: number, hosts: string[]) => {
      record(hosts);
      return { totalRequests: 0, uniqueIps: 0, blockedRequests: 0, blockedPercent: 0, bytesServed: 0 };
    },
    queryWafCount: async (_from: number, _to: number, hosts: string[] = []) => { record(hosts); return 0; },
    queryTopWafRulesWithHosts: async (_from: number, _to: number, _limit: number, hosts: string[] = []) => { record(hosts); return []; },
    queryWafCountries: async (_from: number, _to: number, hosts: string[] = []) => { record(hosts); return []; },
    queryUsageTotals: async (_from: number, _to: number, hosts: string[]) => {
      record(hosts);
      return { requests: hosts.length * 100, bytes: hosts.length * 1000, wafBlocks: hosts.length };
    },
  };
});
// The certificates page and overview read Caddy's certificates over TLS; no network here.
vi.mock('@/src/lib/managed-certificates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/managed-certificates')>()),
  getManagedCertificateExpiry: vi.fn(async () => new Map()),
}));
vi.mock('@/src/lib/l4-ports', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/l4-ports')>()),
  applyL4Ports: vi.fn(async () => ({ state: 'idle' })),
  getL4PortsDiff: vi.fn(async () => ({ required: [], applied: [], changed: false })),
  getL4PortsStatus: vi.fn(() => ({ state: 'idle' })),
}));

import { setTrustedLicenseKeysForTests } from '@/ee/licensing/public-keys';
import { isOrganizationPermission, type Permission } from '@/src/lib/permissions';
import * as hostsRoute from '@/app/api/v1/proxy-hosts/route';
import * as hostRoute from '@/app/api/v1/proxy-hosts/[id]/route';
import * as faRoute from '@/app/api/v1/proxy-hosts/[id]/forward-auth-access/route';
import * as rulesRoute from '@/app/api/v1/proxy-hosts/[id]/mtls-access-rules/route';
import * as certsRoute from '@/app/api/v1/certificates/route';
import * as certRoute from '@/app/api/v1/certificates/[id]/route';
import * as caRoute from '@/app/api/v1/ca-certificates/route';
import * as clientCertsRoute from '@/app/api/v1/client-certificates/route';
import * as mtlsRolesRoute from '@/app/api/v1/mtls-roles/route';
import * as listsRoute from '@/app/api/v1/access-lists/route';
import * as listRoute from '@/app/api/v1/access-lists/[id]/route';
import * as entriesRoute from '@/app/api/v1/access-lists/[id]/entries/route';
import * as entryRoute from '@/app/api/v1/access-lists/[id]/entries/[entryId]/route';
import * as listRulesRoute from '@/app/api/v1/access-lists/[id]/rules/route';
import * as listRuleRoute from '@/app/api/v1/access-lists/[id]/rules/[ruleId]/route';
import * as listRulesReorderRoute from '@/app/api/v1/access-lists/[id]/rules/reorder/route';
import * as blockedSourcesRoute from '@/app/api/v1/access-lists/blocked-sources/route';
import * as blockedSourceEntriesRoute from '@/app/api/v1/access-lists/blocked-sources/entries/route';
import * as groupsRoute from '@/app/api/v1/groups/route';
import * as groupRoute from '@/app/api/v1/groups/[id]/route';
import * as membersRoute from '@/app/api/v1/groups/[id]/members/route';
import * as memberRoute from '@/app/api/v1/groups/[id]/members/[userId]/route';
import * as usersRoute from '@/app/api/v1/users/route';
import * as userRoute from '@/app/api/v1/users/[id]/route';
import * as userMfaRoute from '@/app/api/v1/users/[id]/mfa/route';
import * as rolesRoute from '@/app/api/v1/roles/route';
import * as faSessionsRoute from '@/app/api/v1/forward-auth-sessions/route';
import * as faSessionRoute from '@/app/api/v1/forward-auth-sessions/[id]/route';
import * as tokensRoute from '@/app/api/v1/tokens/route';
import * as tokenRoute from '@/app/api/v1/tokens/[id]/route';
import * as auditRoute from '@/app/api/v1/audit-log/route';
import * as auditExportRoute from '@/app/api/v1/audit-log/export/route';
import * as auditVerifyRoute from '@/app/api/v1/audit-log/verify/route';
import * as analyticsQueryRoute from '@/app/api/v1/analytics/query/route';
import * as analyticsTopRoute from '@/app/api/v1/analytics/top/route';
import * as analyticsRequestsRoute from '@/app/api/v1/analytics/requests/route';
import * as usageRoute from '@/app/api/v1/usage-reports/route';
import * as organizationsRoute from '@/app/api/v1/organizations/route';
import * as moveRoute from '@/app/api/v1/organizations/move/route';
import {
  createProxyHostAction,
  deleteProxyHostAction,
  toggleProxyHostAction,
  updateProxyHostAction,
} from '@/app/(dashboard)/proxy-hosts/actions';
import { deleteCertificateAction, updateCertificateAction } from '@/app/(dashboard)/certificates/actions';
import { createCaCertificateAction } from '@/app/(dashboard)/certificates/ca-actions';
import {
  blockSourceAction,
  deleteAccessListAction,
  saveAccessListAction,
  saveBlockedSourcesAction,
} from '@/app/(dashboard)/access-lists/actions';
import {
  addGroupMemberAction,
  deleteGroupAction,
  removeGroupMemberAction,
  updateGroupAction,
} from '@/app/(dashboard)/groups/actions';
import {
  createUserAction,
  deleteUserAction,
  updateUserInfoAction,
  updateUserRoleAction,
  updateUserStatusAction,
} from '@/app/(dashboard)/users/actions';
import { resetUserMfaAction } from '@/app/(dashboard)/users/mfa-actions';
import { saveRoleAction } from '@/ee/custom-roles/ui/actions';
import { verifyAuditLogAction } from '@/ee/audit/ui/actions';
import { setOrganizationViewAction } from '@/ee/multi-tenancy/ui/actions';
import ProxyHostsPage from '@/app/(dashboard)/proxy-hosts/page';
import CertificatesPage from '@/app/(dashboard)/certificates/page';
import AccessListsPage from '@/app/(dashboard)/access-lists/page';
import GroupsPage from '@/app/(dashboard)/groups/page';
import UsersPage from '@/app/(dashboard)/users/page';
import AuditLogPage from '@/app/(dashboard)/audit-log/page';
import UsagePage from '@/app/(dashboard)/usage/page';
import { first } from '@/src/lib/db/ops';

let tokens: TenantTokens;
let rows: TenantRows;

beforeEach(async () => {
  ctx.db = createTestDb();
  ctx.sessionUserId = A_ADMIN;
  ctx.viewCookie = undefined;
  ctx.seenHosts = [];
  ctx.queriedHosts = [];
  ctx.analyticsQueries = [];
  setTrustedLicenseKeysForTests(licenseSigner.keys);
  await installLicense(ctx.db, 'msp');
  ({ tokens, rows } = await seedTenants(ctx.db));
});

afterAll(() => setTrustedLicenseKeysForTests(null));

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

function body(value: unknown): string {
  return JSON.stringify(value ?? null);
}

type Attack = { name: string; status: number; run: () => Promise<Response> };

/** Every operation on BRAVO's and the provider's rows through the REST API, as ALPHA's administrator. */
function restAttacks(token: string): Attack[] {
  const req = (method: string, path: string, payload?: unknown) => apiRequest(method, path, token, payload);
  const attacks: Attack[] = [];
  for (const [owner, host, cert, list, group] of [
    ['BRAVO', rows.hosts.b, rows.certs.b, rows.lists.b, rows.groups.b],
    ['provider', rows.hosts.p, rows.certs.p, rows.lists.p, rows.groups.p],
  ] as const) {
    attacks.push(
      { name: `GET ${owner} proxy host`, status: 404, run: () => hostRoute.GET(req('GET', '/x'), idParams(host)) },
      { name: `PUT ${owner} proxy host`, status: 404, run: () => hostRoute.PUT(req('PUT', '/x', { name: 'Taken' }), idParams(host)) },
      { name: `DELETE ${owner} proxy host`, status: 404, run: () => hostRoute.DELETE(req('DELETE', '/x'), idParams(host)) },
      { name: `GET ${owner} forward-auth access`, status: 404, run: () => faRoute.GET(req('GET', '/x'), idParams(host)) },
      { name: `PUT ${owner} forward-auth access`, status: 404, run: () => faRoute.PUT(req('PUT', '/x', { userIds: [A_USER] }), idParams(host)) },
      { name: `GET ${owner} mTLS rules`, status: 404, run: () => rulesRoute.GET(req('GET', '/x'), idParams(host)) },
      { name: `GET ${owner} certificate`, status: 404, run: () => certRoute.GET(req('GET', '/x'), idParams(cert)) },
      { name: `PUT ${owner} certificate`, status: 404, run: () => certRoute.PUT(req('PUT', '/x', { name: 'Taken' }), idParams(cert)) },
      { name: `DELETE ${owner} certificate`, status: 404, run: () => certRoute.DELETE(req('DELETE', '/x'), idParams(cert)) },
      { name: `GET ${owner} access list`, status: 404, run: () => listRoute.GET(req('GET', '/x'), idParams(list)) },
      { name: `PUT ${owner} access list`, status: 404, run: () => listRoute.PUT(req('PUT', '/x', { name: 'Taken' }), idParams(list)) },
      { name: `DELETE ${owner} access list`, status: 404, run: () => listRoute.DELETE(req('DELETE', '/x'), idParams(list)) },
      {
        name: `POST ${owner} access list entry`,
        status: 404,
        run: () => entriesRoute.POST(req('POST', '/x', { username: 'intruder', password: 'Intruder-Passw0rd!' }), idParams(list)),
      },
      { name: `GET ${owner} access list rules`, status: 404, run: () => listRulesRoute.GET(req('GET', '/x'), idParams(list)) },
      {
        name: `POST ${owner} access list rule`,
        status: 404,
        run: () => listRulesRoute.POST(req('POST', '/x', { action: 'allow', kind: 'ip', values: ['198.51.100.7'] }), idParams(list)),
      },
      {
        name: `PUT ${owner} access list rules`,
        status: 404,
        run: () => listRulesRoute.PUT(req('PUT', '/x', { rules: [{ action: 'allow', kind: 'ip', values: ['198.51.100.7'] }] }), idParams(list)),
      },
      {
        name: `POST ${owner} access list rule order`,
        status: 404,
        run: () => listRulesReorderRoute.POST(req('POST', '/x', { ruleIds: [] }), idParams(list)),
      },
      {
        name: `DELETE ${owner} access list rule`,
        status: 404,
        run: () => listRuleRoute.DELETE(req('DELETE', '/x'), { params: Promise.resolve({ id: String(list), ruleId: '1' }) }),
      },
      { name: `GET ${owner} group`, status: 404, run: () => groupRoute.GET(req('GET', '/x'), idParams(group)) },
      { name: `PATCH ${owner} group`, status: 404, run: () => groupRoute.PATCH(req('PATCH', '/x', { name: 'Taken' }), idParams(group)) },
      { name: `DELETE ${owner} group`, status: 404, run: () => groupRoute.DELETE(req('DELETE', '/x'), idParams(group)) },
      { name: `POST ${owner} group member`, status: 404, run: () => membersRoute.POST(req('POST', '/x', { userId: A_USER }), idParams(group)) },
    );
  }
  attacks.push(
    {
      name: 'DELETE BRAVO access list entry through ALPHA list',
      status: 200,
      run: () => entryRoute.DELETE(req('DELETE', '/x'), { params: Promise.resolve({ id: String(rows.lists.a), entryId: String(rows.entries.b) }) }),
    },
    {
      name: 'DELETE BRAVO access list entry',
      status: 404,
      run: () => entryRoute.DELETE(req('DELETE', '/x'), { params: Promise.resolve({ id: String(rows.lists.b), entryId: String(rows.entries.b) }) }),
    },
    {
      name: 'DELETE BRAVO group member',
      status: 404,
      run: () => memberRoute.DELETE(req('DELETE', '/x'), { params: Promise.resolve({ id: String(rows.groups.b), userId: String(B_USER) }) }),
    },
    { name: 'POST BRAVO user into ALPHA group', status: 404, run: () => membersRoute.POST(req('POST', '/x', { userId: B_USER }), idParams(rows.groups.a)) },
    { name: 'PUT ALPHA forward-auth access naming BRAVO user', status: 404, run: () => faRoute.PUT(req('PUT', '/x', { userIds: [B_USER] }), idParams(rows.hosts.a)) },
    { name: 'PUT ALPHA forward-auth access naming BRAVO group', status: 404, run: () => faRoute.PUT(req('PUT', '/x', { groupIds: [rows.groups.b] }), idParams(rows.hosts.a)) },
    { name: 'PUT ALPHA host with BRAVO certificate', status: 403, run: () => hostRoute.PUT(req('PUT', '/x', { certificateId: rows.certs.b }), idParams(rows.hosts.a)) },
    { name: 'PUT ALPHA host with BRAVO access list', status: 403, run: () => hostRoute.PUT(req('PUT', '/x', { accessListId: rows.lists.b }), idParams(rows.hosts.a)) },
    { name: 'PUT ALPHA host onto BRAVO domain', status: 409, run: () => hostRoute.PUT(req('PUT', '/x', { domains: ['app.bravo.example.com'] }), idParams(rows.hosts.a)) },
    {
      name: 'POST host on BRAVO domain',
      status: 409,
      run: () => hostsRoute.POST(req('POST', '/x', { name: 'Steal', domains: ['app.bravo.example.com'], upstreams: ['10.1.0.9:80'] })),
    },
    {
      name: 'POST host on a wildcard covering BRAVO',
      status: 409,
      run: () => hostsRoute.POST(req('POST', '/x', { name: 'Steal', domains: ['*.bravo.example.com'], upstreams: ['10.1.0.9:80'] })),
    },
    {
      name: 'POST host into BRAVO',
      status: 403,
      run: () => hostsRoute.POST(req('POST', '/x', { name: 'Plant', domains: ['plant.alpha.example.com'], upstreams: ['10.1.0.9:80'], organizationId: ORG_B })),
    },
    {
      name: 'POST certificate for BRAVO domain',
      status: 409,
      run: () => certsRoute.POST(req('POST', '/x', { name: 'Steal', type: 'managed', domainNames: ['app.bravo.example.com'] })),
    },
    { name: 'GET CA certificates', status: 403, run: () => caRoute.GET(req('GET', '/x')) },
    { name: 'GET client certificates', status: 403, run: () => clientCertsRoute.GET(req('GET', '/x')) },
    { name: 'GET mTLS roles', status: 403, run: () => mtlsRolesRoute.GET(req('GET', '/x')) },
    { name: 'POST mTLS rule on ALPHA host', status: 403, run: () => rulesRoute.POST(req('POST', '/x', { pathPattern: '/x/*', allowedRoleIds: [] }), idParams(rows.hosts.a)) },
    { name: 'GET BRAVO user', status: 404, run: () => userRoute.GET(req('GET', '/x'), idParams(B_ADMIN)) },
    { name: 'GET provider user', status: 404, run: () => userRoute.GET(req('GET', '/x'), idParams(PROVIDER_ADMIN)) },
    { name: 'PUT BRAVO user', status: 404, run: () => userRoute.PUT(req('PUT', '/x', { name: 'Taken', status: 'disabled' }), idParams(B_ADMIN)) },
    { name: 'PUT provider admin', status: 404, run: () => userRoute.PUT(req('PUT', '/x', { role: 'viewer' }), idParams(PROVIDER_ADMIN)) },
    { name: 'DELETE BRAVO user', status: 404, run: () => userRoute.DELETE(req('DELETE', '/x'), idParams(B_USER)) },
    { name: 'GET BRAVO user MFA', status: 404, run: () => userMfaRoute.GET(req('GET', '/x'), idParams(B_ADMIN)) },
    { name: 'DELETE BRAVO user MFA', status: 404, run: () => userMfaRoute.DELETE(req('DELETE', '/x'), idParams(B_ADMIN)) },
    {
      name: 'POST user as admin',
      status: 400,
      run: () => usersRoute.POST(req('POST', '/x', { email: 'root@alpha.example.com', password: 'Correct-Horse-9!x', role: 'admin' })),
    },
    {
      name: 'POST user into BRAVO',
      status: 403,
      run: () => usersRoute.POST(req('POST', '/x', { email: 'plant@alpha.example.com', password: 'Correct-Horse-9!x', organizationId: ORG_B })),
    },
    { name: 'PUT ALPHA user to admin', status: 400, run: () => userRoute.PUT(req('PUT', '/x', { role: 'admin' }), idParams(A_USER)) },
    { name: 'GET roles', status: 403, run: () => rolesRoute.GET(req('GET', '/x')) },
    { name: 'POST role', status: 403, run: () => rolesRoute.POST(req('POST', '/x', { name: 'Mine', permissions: ['proxy_hosts:read'] })) },
    { name: 'DELETE BRAVO user forward-auth sessions', status: 404, run: () => faSessionsRoute.DELETE(req('DELETE', `/x?userId=${B_USER}`)) },
    { name: 'DELETE BRAVO forward-auth session', status: 404, run: () => faSessionRoute.DELETE(req('DELETE', '/x'), idParams(rows.sessions.b)) },
    { name: 'DELETE BRAVO API token', status: 404, run: () => tokenRoute.DELETE(req('DELETE', '/x'), idParams(rows.tokenIds.bAdmin)) },
    { name: 'GET audit verification', status: 403, run: () => auditVerifyRoute.GET(req('GET', '/x')) },
    { name: 'GET BRAVO usage report', status: 404, run: () => usageRoute.GET(req('GET', `/x?organizationId=${ORG_B}`)) },
    { name: 'GET Blocked sources', status: 403, run: () => blockedSourcesRoute.GET(req('GET', '/x')) },
    { name: 'PUT Blocked sources', status: 403, run: () => blockedSourcesRoute.PUT(req('PUT', '/x', { failClosed: true })) },
    { name: 'POST blocked source', status: 403, run: () => blockedSourceEntriesRoute.POST(req('POST', '/x', { address: '198.51.100.7' })) },
    { name: 'GET organisations', status: 403, run: () => organizationsRoute.GET(req('GET', '/x')) },
    { name: 'POST organisation', status: 403, run: () => organizationsRoute.POST(req('POST', '/x', { name: 'Mine' })) },
    { name: 'POST move', status: 403, run: () => moveRoute.POST(req('POST', '/x', { organizationId: ORG_A, proxyHostIds: [rows.hosts.b] })) },
  );
  return attacks;
}

describe('REST: ALPHA attacks BRAVO and the provider level', () => {
  for (const tokenName of ['aAdmin', 'aEverything'] as const) {
    it(`answers every attack with 404/403 and changes nothing (${tokenName})`, async () => {
      const before = await snapshotOutsideAlpha(ctx.db);
      for (const attack of restAttacks(tokens[tokenName])) {
        const response = await attack.run();
        const data = await json(response);
        expect(response.status, attack.name).toBe(attack.status);
        expect(leaks(data), `${attack.name}: ${body(data)}`).toBe(false);
      }
      expect(await snapshotOutsideAlpha(ctx.db)).toEqual(before);
    });
  }

  it('lists only ALPHA rows', async () => {
    const req = (path: string) => apiRequest('GET', path, tokens.aAdmin);
    const lists: Array<[string, Response]> = [
      ['proxy hosts', await hostsRoute.GET(req('/x'))],
      ['proxy hosts filtered to BRAVO', await hostsRoute.GET(req(`/x?organizationId=${ORG_B}`))],
      ['certificates', await certsRoute.GET(req('/x'))],
      ['access lists', await listsRoute.GET(req('/x'))],
      ['groups', await groupsRoute.GET(req('/x'))],
      ['users', await usersRoute.GET(req('/x'))],
      ['users filtered to provider', await usersRoute.GET(req('/x?organizationId=provider'))],
      ['forward-auth sessions', await faSessionsRoute.GET(req('/x'))],
      ['API tokens', await tokensRoute.GET(req('/x'))],
      ['audit log', await auditRoute.GET(req('/x'))],
      ['audit log searched', await auditRoute.GET(req('/x?search=BRAVO'))],
    ];
    for (const [name, response] of lists) {
      const data = await json(response);
      expect(response.status, name).toBe(200);
      expect(leaks(data), `${name}: ${body(data)}`).toBe(false);
    }
    const hosts = await json(await hostsRoute.GET(req('/x')));
    expect(hosts.map((host: { name: string }) => host.name)).toEqual(['Alpha app']);
    const users = await json(await usersRoute.GET(req('/x')));
    expect(users.map((user: { id: number }) => user.id).sort()).toEqual([A_ADMIN, A_USER, A_EVERYTHING]);
    const events = await json(await auditRoute.GET(req('/x')));
    expect(events.events.map((event: { summary: string }) => event.summary)).toEqual(['Alpha event']);
  });

  it('removes an access list entry only from the list it names', async () => {
    const response = await entryRoute.DELETE(
      apiRequest('DELETE', '/x', tokens.aAdmin),
      { params: Promise.resolve({ id: String(rows.lists.a), entryId: String(rows.entries.b) }) }
    );
    expect(response.status).toBe(200);
    expect(await first(ctx.db.select().from(schema.accessListEntries).where(eq(schema.accessListEntries.id, rows.entries.b)).limit(1))).toBeDefined();
  });

  it('gives the provider every row and its filters', async () => {
    const req = (path: string) => apiRequest('GET', path, tokens.provider);
    expect(await json(await hostsRoute.GET(req('/x')))).toHaveLength(3);
    const bravo = await json(await hostsRoute.GET(req(`/x?organizationId=${ORG_B}`)));
    expect(bravo.map((host: { name: string }) => host.name)).toEqual(['BRAVO app']);
    const provider = await json(await hostsRoute.GET(req('/x?organizationId=provider')));
    expect(provider.map((host: { name: string }) => host.name)).toEqual(['PROVIDER app']);
    expect((await hostRoute.GET(req('/x'), idParams(rows.hosts.b))).status).toBe(200);
    expect((await hostsRoute.GET(req('/x?organizationId=nope'))).status).toBe(400);
  });

  it('lets ALPHA work on its own rows', async () => {
    const req = (method: string, payload?: unknown) => apiRequest(method, '/x', tokens.aAdmin, payload);
    expect((await hostRoute.PUT(req('PUT', { name: 'Alpha renamed' }), idParams(rows.hosts.a))).status).toBe(200);
    const created = await hostsRoute.POST(req('POST', { name: 'Alpha two', domains: ['two.alpha.example.com'], upstreams: ['api.alpha.example.com:443'] }));
    expect(created.status).toBe(201);
    expect((await json(created)).organizationId).toBe(ORG_A);
    const user = await usersRoute.POST(req('POST', { email: 'new@alpha.example.com', password: 'Correct-Horse-9!x', role: 'org_admin' }));
    expect(user.status).toBe(201);
    expect(await json(user)).toMatchObject({ organizationId: ORG_A, role: 'org_admin' });
    expect((await groupRoute.PATCH(req('PATCH', { name: 'Alpha team' }), idParams(rows.groups.a))).status).toBe(200);
    expect((await listRoute.PUT(req('PUT', { name: 'Alpha list 2' }), idParams(rows.lists.a))).status).toBe(200);
    expect((await certRoute.PUT(req('PUT', { name: 'Alpha cert 2' }), idParams(rows.certs.a))).status).toBe(200);
    expect((await faRoute.PUT(req('PUT', { userIds: [A_USER], groupIds: [rows.groups.a] }), idParams(rows.hosts.a))).status).toBe(200);
    // A group of the same name as BRAVO's is ALPHA's own business.
    expect((await groupsRoute.POST(req('POST', { name: 'BRAVO staff' }))).status).toBe(201);
  });
});

describe('REST: provider-level surfaces are closed to organisation users', () => {
  const sites = findPermissionCallSites().filter(
    (site) => site.file.startsWith('app/api/') && !isOrganizationPermission(site.permission as Permission)
  );

  async function call(site: CallSite, token: string): Promise<Response> {
    const mod = await import(/* @vite-ignore */ `../../${site.file}`);
    const handler = mod[site.fn] as (req: unknown, context: unknown) => Promise<Response>;
    const url = new URL(`https://dash.example.com/${site.file.replace(/^app\//, '').replace(/\/route\.ts$/, '')}`);
    const request = {
      method: site.fn,
      url: url.toString(),
      headers: new Headers({ authorization: `Bearer ${token}`, 'content-type': 'application/json' }),
      nextUrl: url,
      cookies: { get: () => undefined },
      json: async () => ({}),
      text: async () => '{}',
      formData: async () => new FormData(),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
    const values = new Proxy({}, { get: (_target, key) => (typeof key === 'string' ? (key === 'group' ? 'general' : '1') : undefined) });
    return handler(request, { params: Promise.resolve(values) });
  }

  it('covers the provider-level call sites', () => {
    expect(sites.length).toBeGreaterThan(100);
  });

  it.each(sites.map((site) => [`${site.fn} ${site.file} (${site.permission})`, site] as const))(
    'refuses %s to an ALPHA user holding every permission',
    async (_name, site) => {
      const response = await call(site, tokens.aEverything);
      expect(response.status).toBe(403);
      // settings/[group] checks the permission of the group it is called with.
      expect((await json(response)).error).toMatch(/^Permission required: /);
    },
    20_000
  );
});

describe('dashboard server actions: ALPHA attacks BRAVO', () => {
  it('refuses every action on BRAVO rows and changes nothing', async () => {
    ctx.sessionUserId = A_ADMIN;
    const before = await snapshotOutsideAlpha(ctx.db);

    expect(await updateProxyHostAction(rows.hosts.b, undefined, form({ name: 'Taken' }))).toMatchObject({ status: 'error', message: 'Proxy host not found' });
    expect(await deleteProxyHostAction(rows.hosts.b)).toMatchObject({ status: 'error', message: 'Proxy host not found' });
    expect(await toggleProxyHostAction(rows.hosts.b, false)).toMatchObject({ status: 'error' });
    expect(await createProxyHostAction(undefined, form({ name: 'Steal', domains: 'app.bravo.example.com', upstreams: '10.1.0.9:80' })))
      .toMatchObject({ status: 'error' });
    expect(await createProxyHostAction(undefined, form({ name: 'Raw', domains: 'raw.alpha.example.com', upstreams: '10.1.0.9:80', customReverseProxyJson: '{"handler":"static_response"}' })))
      .toMatchObject({ status: 'error' });

    await expect(updateCertificateAction(rows.certs.b, form({ name: 'Taken' }))).rejects.toThrow(/not found/);
    await expect(deleteCertificateAction(rows.certs.b)).rejects.toThrow(/not found/);
    await expect(createCaCertificateAction(form({ name: 'CA', certificate_pem: 'x' }))).rejects.toThrow(/provider/);

    const listNotFound = { ok: false, error: expect.stringMatching(/not found/) };
    expect(await saveAccessListAction(rows.lists.b, { name: 'Taken' })).toMatchObject(listNotFound);
    expect(await deleteAccessListAction(rows.lists.b)).toMatchObject(listNotFound);
    expect(await saveAccessListAction(rows.lists.b, { members: { add: [{ username: 'intruder', password: 'Intruder-Passw0rd!' }] } }))
      .toMatchObject(listNotFound);
    expect(await saveAccessListAction(rows.lists.b, { members: { remove: [rows.entries.b] } })).toMatchObject(listNotFound);
    expect(await saveAccessListAction(rows.lists.b, { members: { passwords: [{ id: rows.entries.b, password: 'Another-Passw0rd!' }] } }))
      .toMatchObject(listNotFound);
    expect(await saveAccessListAction(rows.lists.b, { rules: [{ action: 'allow', kind: 'ip', values: ['198.51.100.1'] }] }))
      .toMatchObject(listNotFound);
    // The global Blocked sources list is the provider's: an organisation user cannot block anything everywhere.
    expect(await blockSourceAction({ address: '198.51.100.1' })).toMatchObject({ ok: false });
    expect(await saveBlockedSourcesAction({ rules: [{ action: 'deny', kind: 'ip', values: ['198.51.100.1'] }] })).toMatchObject({ ok: false });

    const groupNotFound = { ok: false, error: expect.stringMatching(/not found/) };
    expect(await updateGroupAction(rows.groups.b, form({ name: 'Taken' }))).toMatchObject(groupNotFound);
    expect(await deleteGroupAction(rows.groups.b)).toMatchObject(groupNotFound);
    expect(await addGroupMemberAction(rows.groups.b, A_USER)).toMatchObject(groupNotFound);
    expect(await addGroupMemberAction(rows.groups.a, B_USER)).toMatchObject(groupNotFound);
    expect(await removeGroupMemberAction(rows.groups.b, B_USER)).toMatchObject(groupNotFound);

    for (const target of [B_ADMIN, B_USER, PROVIDER_ADMIN, PROVIDER_USER]) {
      expect(await updateUserRoleAction(target, 'viewer')).toMatchObject({ ok: false, error: 'User not found' });
      expect(await updateUserStatusAction(target, 'disabled')).toMatchObject({ ok: false, error: 'User not found' });
      expect(await updateUserInfoAction(target, form({ name: 'Taken' }))).toMatchObject({ ok: false, error: 'User not found' });
      expect(await deleteUserAction(target)).toMatchObject({ ok: false, error: 'User not found' });
      expect(await resetUserMfaAction(target)).toMatchObject({ ok: false, error: 'User not found' });
    }
    expect(await updateUserRoleAction(A_USER, 'admin')).toMatchObject({ ok: false });
    expect(await saveRoleAction(null, { name: 'Mine', permissions: ['proxy_hosts:read'] })).toMatchObject({ ok: false });
    expect(await verifyAuditLogAction()).toMatchObject({ error: expect.stringMatching(/provider/) });
    await expect(setOrganizationViewAction(String(ORG_B))).rejects.toThrow(/Permission required/);

    expect(await snapshotOutsideAlpha(ctx.db)).toEqual(before);
  });

  it('creates rows in ALPHA from the dashboard', async () => {
    ctx.sessionUserId = A_ADMIN;
    expect(await createProxyHostAction(undefined, form({ name: 'Form host', domains: 'form.alpha.example.com', upstreams: '10.1.0.9:80' })))
      .toMatchObject({ status: 'success' });
    expect((await first(ctx.db.select().from(schema.proxyHosts).where(eq(schema.proxyHosts.name, 'Form host')).limit(1)))!.organizationId).toBe(ORG_A);
    expect(await createUserAction(form({ email: 'member@alpha.example.com', password: 'Correct-Horse-9!x', role: 'org_admin' }))).toEqual({ ok: true });
    expect(await first(ctx.db.select().from(schema.users).where(eq(schema.users.email, 'member@alpha.example.com')).limit(1)))
      .toMatchObject({ organizationId: ORG_A, role: 'org_admin' });
  });
});

describe('dashboard pages', () => {
  const searchParams = { searchParams: Promise.resolve({}) };
  type Props = { props: Record<string, unknown> };

  it('show ALPHA only its own rows', async () => {
    ctx.sessionUserId = A_ADMIN;
    const pages: Array<[string, Props]> = [
      ['proxy hosts', await ProxyHostsPage(searchParams) as Props],
      ['certificates', await CertificatesPage(searchParams) as Props],
      ['access lists', await AccessListsPage() as Props],
      ['groups', await GroupsPage() as Props],
      ['users', await UsersPage() as Props],
      ['audit log', await AuditLogPage(searchParams) as Props],
      ['usage', await UsagePage() as Props],
    ];
    for (const [name, page] of pages) {
      expect(leaks(page.props), `${name}: ${body(page.props)}`).toBe(false);
    }
    const hosts = (pages[0][1].props.hosts as Array<{ name: string }>).map((host) => host.name);
    expect(hosts).toEqual(['Alpha app']);
    expect(pages[0][1].props.caCertificates).toEqual([]);
    expect(pages[4][1].props.rolesTab).toBeNull();
  });

  it('show the provider every row, or the organisation it picked', async () => {
    ctx.sessionUserId = PROVIDER_ADMIN;
    const all = await ProxyHostsPage(searchParams) as Props;
    expect((all.props.hosts as unknown[]).length).toBe(3);
    ctx.viewCookie = String(ORG_B);
    const bravo = await ProxyHostsPage(searchParams) as Props;
    expect((bravo.props.hosts as Array<{ name: string }>).map((host) => host.name)).toEqual(['BRAVO app']);
    ctx.viewCookie = 'provider';
    const provider = await ProxyHostsPage(searchParams) as Props;
    expect((provider.props.hosts as Array<{ name: string }>).map((host) => host.name)).toEqual(['PROVIDER app']);
  });
});

describe('exports', () => {
  it('exports only ALPHA audit events, without naming outside actors', async () => {
    await ctx.db.insert(schema.auditEvents).values({
      userId: PROVIDER_ADMIN, action: 'update', entityType: 'proxy_host', entityId: rows.hosts.a,
      summary: 'Provider changed an Alpha host', organizationId: ORG_A, createdAt: new Date().toISOString(),
    });
    for (const format of ['csv', 'json']) {
      const response = await auditExportRoute.GET(apiRequest('GET', `/x?format=${format}`, tokens.aAdmin));
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('Alpha event');
      expect(text).toContain('Provider changed an Alpha host');
      expect(text).not.toMatch(/BRAVO|PROVIDER event|provider-admin/);
    }
  });

  it('exports only the ALPHA usage row as CSV', async () => {
    const response = await usageRoute.GET(apiRequest('GET', '/x?format=csv', tokens.aAdmin));
    expect(response.status).toBe(200);
    const lines = (await response.text()).trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^1,alpha,Alpha,/);
  });
});

describe('analytics', () => {
  beforeEach(() => {
    ctx.seenHosts = ['app.alpha.example.com', 'APP.alpha.example.com:8443', 'app.bravo.example.com', 'app.provider.example.com', 'unknown.example.com'];
  });

  /** The host scope every ClickHouse query since `from` ran with (sorted), one entry per query. */
  const scopes = (from = 0) =>
    ctx.analyticsQueries.slice(from).map((call) => {
      const scope = call.query_params.p_scope as string[] | undefined;
      return scope ? [...scope].sort() : call.query.includes('AND 0 AND') ? 'nothing' : 'everything';
    });

  it('limits every query to ALPHA host names, whatever the filters ask for', async () => {
    const req = (path: string) => apiRequest('GET', path, tokens.aAdmin);
    const alpha = ['APP.alpha.example.com:8443', 'app.alpha.example.com'];
    const bravo = encodeURIComponent(JSON.stringify([{ dim: 'host', op: 'is', value: 'app.bravo.example.com' }]));
    for (const route of [
      () => analyticsQueryRoute.GET(req('/x')),
      () => analyticsQueryRoute.GET(req(`/x?filters=${bravo}&groupBy=host`)),
      () => analyticsTopRoute.GET(req(`/x?filters=${bravo}`)),
      () => analyticsRequestsRoute.GET(req(`/x?filters=${bravo}`)),
    ]) {
      const before = ctx.analyticsQueries.length;
      const response = await route();
      expect(response.status).toBe(200);
      expect(ctx.analyticsQueries.length).toBeGreaterThan(before);
      for (const scope of scopes(before)) expect(scope).toEqual(alpha);
    }
  });

  it('queries nothing for an organisation with no hosts', async () => {
    await ctx.db.delete(schema.proxyHosts).where(eq(schema.proxyHosts.organizationId, ORG_A));
    ctx.seenHosts = ['app.bravo.example.com'];
    await analyticsQueryRoute.GET(apiRequest('GET', '/x', tokens.aAdmin));
    expect(scopes().length).toBeGreaterThan(0);
    for (const scope of scopes()) expect(scope).toBe('nothing');
  });

  it('leaves the provider unrestricted', async () => {
    await analyticsQueryRoute.GET(apiRequest('GET', '/x', tokens.provider));
    expect(scopes().length).toBeGreaterThan(0);
    for (const scope of scopes()) expect(scope).toBe('everything');
  });

  it('reports usage over each organisation\'s host names', async () => {
    const report = await json(await usageRoute.GET(apiRequest('GET', '/x', tokens.provider)));
    const byName = Object.fromEntries(report.rows.map((row: { organizationName: string }) => [row.organizationName, row]));
    expect(Object.keys(byName).sort()).toEqual(['Alpha', 'BRAVO', 'Provider']);
    expect(byName.Alpha).toMatchObject({ proxyHosts: 1, users: 3, requests: 200 });
    expect(byName.BRAVO).toMatchObject({ proxyHosts: 1, users: 2, requests: 100 });
    const own = await json(await usageRoute.GET(apiRequest('GET', '/x', tokens.aAdmin)));
    expect(own.rows.map((row: { organizationName: string }) => row.organizationName)).toEqual(['Alpha']);
  });
});
