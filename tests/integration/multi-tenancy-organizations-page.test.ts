/**
 * The Organisations page (ee/multi-tenancy/page-data.ts and
 * app/(dashboard)/organizations/page.tsx): the list with counts against
 * limits, usage and "disabled since", the opened organisation with its
 * hosts and members, and what a narrower role sees. The page carries display
 * fields only: no host configuration, password hash or token reaches the
 * client.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { insertRole, nowIso } from '../helpers/custom-roles';
import { installLicense, licenseSigner } from '../helpers/config-fixture';
import {
  A_ADMIN,
  A_USER,
  ORG_A,
  ORG_B,
  PROVIDER_ADMIN,
  insertTenantUser,
  seedTenants,
  type TenantRows,
} from '../helpers/multi-tenancy';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  sessionUserId: 0,
  viewCookie: undefined as string | undefined,
  seenHosts: [] as string[],
  queried: [] as { from: number; to: number; hosts: string[] }[],
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
vi.mock('@clickhouse/client', () => {
  const unavailable = async () => { throw new Error('ClickHouse is not available in tests'); };
  return { createClient: () => ({ query: unavailable, insert: unavailable, command: unavailable, exec: unavailable, ping: unavailable, close: async () => {} }) };
});
vi.mock('../../src/lib/clickhouse/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/lib/clickhouse/client')>();
  return {
    ...original,
    isAnalyticsEnabled: () => true,
    queryDistinctHostsAll: async () => [...ctx.seenHosts],
    queryUsageTotals: async (from: number, to: number, hosts: string[]) => {
      ctx.queried.push({ from, to, hosts: [...hosts] });
      return { requests: hosts.length * 100, bytes: hosts.length * 1000, wafBlocks: hosts.length };
    },
  };
});

import { setTrustedLicenseKeysForTests } from '@/ee/licensing/public-keys';
import { loadOrganizationsPage, usageMonths } from '@/ee/multi-tenancy/page-data';
import { getSessionAccess, requireUser } from '@/src/lib/auth';
import OrganizationsPage from '@/app/(dashboard)/organizations/page';

const READER = 20;
const READER_ROLE = 20;
const NOW = new Date('2026-10-03T12:00:00.000Z');

let rows: TenantRows;

async function accessOf(userId: number) {
  ctx.sessionUserId = userId;
  return await getSessionAccess(await requireUser());
}

beforeEach(async () => {
  ctx.db = createTestDb();
  ctx.sessionUserId = PROVIDER_ADMIN;
  ctx.viewCookie = undefined;
  ctx.seenHosts = [];
  ctx.queried = [];
  setTrustedLicenseKeysForTests(licenseSigner.keys);
  await installLicense(ctx.db, 'msp');
  ({ rows } = await seedTenants(ctx.db));
  await ctx.db.update(schema.organizations).set({ maxProxyHosts: 1, maxUsers: 10 }).where(eq(schema.organizations.id, ORG_A));
});

afterAll(() => setTrustedLicenseKeysForTests(null));

describe('usage months', () => {
  it('bills the last full calendar month and counts the current one so far', () => {
    expect(usageMonths(NOW)).toEqual({ billing: { month: '2026-09', label: 'September' }, current: { month: '2026-10', label: 'October' } });
    expect(usageMonths(new Date('2026-01-15T00:00:00.000Z')).billing).toEqual({ month: '2025-12', label: 'December' });
  });
});

describe('loadOrganizationsPage', () => {
  it('lists every organisation with counts, limits, usage and the provider level', async () => {
    ctx.seenHosts = ['app.alpha.example.com', 'app.bravo.example.com:443'];
    const data = await loadOrganizationsPage(await accessOf(PROVIDER_ADMIN), null, NOW);
    expect(data.organizations.map((organization) => organization.name)).toEqual(['Alpha', 'BRAVO']);
    const alpha = data.organizations.find((organization) => organization.id === ORG_A)!;
    expect(alpha).toMatchObject({ maxProxyHosts: 1, maxUsers: 10, counts: { proxyHosts: 1, users: 3 }, disabledSince: null });
    expect(alpha.requests).toBe(100);
    expect(data.provider).toEqual({ proxyHosts: 1, users: 2 });
    expect(data.usage).toMatchObject({ billing: { month: '2026-09' }, current: { month: '2026-10' }, analyticsAvailable: true });
    // The billing period is September (UTC).
    expect(ctx.queried.some((query) => new Date(query.from * 1000).toISOString() === '2026-09-01T00:00:00.000Z')).toBe(true);
  });

  it('opens the first organisation by default, or the one asked for', async () => {
    const access = await accessOf(PROVIDER_ADMIN);
    expect((await loadOrganizationsPage(access, null, NOW)).selected?.id).toBe(ORG_A);
    expect((await loadOrganizationsPage(access, ORG_B, NOW)).selected?.id).toBe(ORG_B);
    expect((await loadOrganizationsPage(access, 999, NOW)).selected?.id).toBe(ORG_A);
  });

  it('shows the opened organisation\'s hosts with their protections and its members, as display fields only', async () => {
    ctx.seenHosts = ['app.alpha.example.com'];
    await ctx.db.update(schema.proxyHosts)
      .set({ meta: JSON.stringify({ waf: { enabled: true, mode: 'On', custom_directives: 'SecRule SECRET-DIRECTIVE' } }) })
      .where(eq(schema.proxyHosts.id, rows.hosts.a));
    await ctx.db.update(schema.users).set({ passwordHash: 'HASH-MUST-NOT-LEAK', twoFactorEnabled: true }).where(eq(schema.users.id, A_ADMIN));
    await ctx.db.insert(schema.twoFactors).values({ userId: A_ADMIN, secret: 'TOTP-SECRET-MUST-NOT-LEAK', backupCodes: '[]', verified: true });
    // A flag without a verified second factor is not MFA.
    await ctx.db.update(schema.users).set({ twoFactorEnabled: true }).where(eq(schema.users.id, A_USER));
    await ctx.db.insert(schema.auditEvents).values({
      userId: A_USER, action: 'login_success', entityType: 'user', summary: 'Signed in', createdAt: '2026-10-02T08:47:00.000Z',
    });

    const data = await loadOrganizationsPage(await accessOf(PROVIDER_ADMIN), ORG_A, NOW);
    const detail = data.selected!;
    expect(detail.hosts).toEqual([
      expect.objectContaining({
        id: rows.hosts.a,
        domain: 'app.alpha.example.com',
        upstream: '10.1.0.5:8080',
        requests: 100,
        protections: [{ kind: 'waf', label: 'WAF · Block' }, { kind: 'access-list', label: 'Access list · Alpha list' }],
      }),
    ]);
    expect(detail.hostsTotal).toBe(1);
    expect(detail.usage).toMatchObject({ requests: 100, proxyHosts: 1, enabledProxyHosts: 1 });
    expect(detail.members.map((member) => [member.email, member.roleKind, member.roleLabel])).toEqual([
      ['alpha-admin@example.com', 'org_admin', 'Organisation admin'],
      ['alpha-everything@example.com', 'custom', 'Everything'],
      ['alpha-user@example.com', 'user', 'User'],
    ]);
    const user = detail.members.find((member) => member.id === A_USER)!;
    expect(user.lastSignInAt).toBe('2026-10-02T08:47:00.000Z');
    expect(user.mfa).toBe(false);
    expect(detail.members.find((member) => member.id === A_ADMIN)).toMatchObject({ apiTokens: 1, mfa: true });

    const text = JSON.stringify(data);
    expect(text).not.toContain('HASH-MUST-NOT-LEAK');
    expect(text).not.toContain('SECRET-DIRECTIVE');
    expect(text).not.toContain('tokenHash');
    expect(text).not.toContain('TOTP-SECRET-MUST-NOT-LEAK');
    expect(text).not.toContain('bravo-admin');
  });

  it('dates a disabled organisation from its last "disabled" audit event', async () => {
    await ctx.db.update(schema.organizations).set({ enabled: false }).where(eq(schema.organizations.id, ORG_B));
    for (const createdAt of ['2026-08-01T10:00:00.000Z', '2026-09-28T10:00:00.000Z']) {
      await ctx.db.insert(schema.auditEvents).values({
        userId: PROVIDER_ADMIN, action: 'update', entityType: 'organization', entityId: ORG_B, summary: 'Disabled organisation BRAVO', createdAt,
      });
    }
    await ctx.db.insert(schema.auditEvents).values({
      userId: PROVIDER_ADMIN, action: 'update', entityType: 'organization', entityId: ORG_A, summary: 'Disabled organisation Alpha', createdAt: nowIso(),
    });
    const data = await loadOrganizationsPage(await accessOf(PROVIDER_ADMIN), null, NOW);
    expect(data.organizations.find((organization) => organization.id === ORG_B)!.disabledSince).toBe('2026-09-28T10:00:00.000Z');
    // Enabled again since: no date.
    expect(data.organizations.find((organization) => organization.id === ORG_A)!.disabledSince).toBeNull();
  });

  it('leaves out usage and hosts for a role that may only read organisations', async () => {
    await insertRole(ctx.db, READER_ROLE, ['organizations:read'], [], 'Organisation reader');
    await insertTenantUser(ctx.db, READER, 'viewer', null, READER_ROLE, 'org-reader');
    const data = await loadOrganizationsPage(await accessOf(READER), ORG_A, NOW);
    expect(data.usage).toBeNull();
    expect(data.organizations.every((organization) => organization.requests === null)).toBe(true);
    expect(data.selected).toMatchObject({ usage: null, currentRequests: null, hosts: null, hostsTotal: 1 });
    expect(ctx.queried).toEqual([]);
  });

  it('lists only the hosts inside a role\'s tag scope', async () => {
    await insertRole(ctx.db, READER_ROLE, ['organizations:read', 'proxy_hosts:read'], ['team-x'], 'Scoped reader');
    await insertTenantUser(ctx.db, READER, 'viewer', null, READER_ROLE, 'scoped-reader');
    const data = await loadOrganizationsPage(await accessOf(READER), ORG_A, NOW);
    expect(data.selected?.hosts).toEqual([]);
    await ctx.db.update(schema.proxyHosts).set({ tags: JSON.stringify(['team-x']) }).where(eq(schema.proxyHosts.id, rows.hosts.a));
    expect((await loadOrganizationsPage(await accessOf(READER), ORG_A, NOW)).selected?.hosts?.map((host) => host.id)).toEqual([rows.hosts.a]);
  });
});

describe('the page', () => {
  type Props = { props: Record<string, unknown> };

  it('opens ?organization=<id> and passes the organisation view', async () => {
    ctx.sessionUserId = PROVIDER_ADMIN;
    ctx.viewCookie = String(ORG_B);
    const page = (await OrganizationsPage({ searchParams: Promise.resolve({ organization: String(ORG_B) }) })) as Props;
    expect((page.props.data as { selected: { id: number } }).selected.id).toBe(ORG_B);
    expect(page.props.view).toBe(String(ORG_B));
    expect(page.props.canWrite).toBe(true);
    expect(page.props.allowed).toEqual({ proxyHosts: true, users: true, createUsers: true });
    expect(typeof page.props.onSetView).toBe('function');
  });

  it('is refused to organisation users', async () => {
    ctx.sessionUserId = A_ADMIN;
    await expect(OrganizationsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow();
  });
});
