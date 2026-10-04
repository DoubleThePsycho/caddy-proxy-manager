/**
 * Every other path that changes a host, against an approval policy
 * (ee/approvals): the dashboard server actions (submit a change request, or
 * an emergency change), forward-auth access and mTLS access rules through the
 * REST API, and the paths that are refused rather than routed through
 * approvals — direct model calls (other callers), WAF rule suppression,
 * configuration import and configuration history rollback. Instance sync applying the master's configuration on a replica is
 * not a user change and keeps working.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { apiRequest, idParams, json } from '../helpers/custom-roles';
import { installLicense, licenseSigner } from '../helpers/config-fixture';
import {
  ADMIN, ALICE, BOB,
  hostRow, insertPolicy, l4Row, requestRow, seedApprovals, type Hosts, type Tokens,
} from '../helpers/approvals';

const ctx = vi.hoisted(() => {
  const { mkdirSync } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const dir = join(tmpdir(), `approvals-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  process.env.L4_PORTS_DIR = dir;
  return { db: null as unknown as TestDb, sessionUserId: 0 };
});

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

import { applyCaddyConfig } from '../../src/lib/caddy';
import { setTrustedLicenseKeysForTests } from '../../ee/licensing/public-keys';
import { createProxyHost, updateProxyHost } from '../../src/lib/models/proxy-hosts';
import { deleteL4ProxyHost, updateL4ProxyHost } from '../../src/lib/models/l4-proxy-hosts';
import { suppressWafRuleForHost } from '../../src/lib/waf-suppression';
import { exportConfiguration, importConfiguration } from '../../src/lib/config-transfer';
import { buildSyncPayload, applySyncPayload } from '../../src/lib/instance-sync';
import { createManualSnapshot, restoreSnapshot } from '../../ee/config-history/service';
import {
  createProxyHostAction,
  deleteProxyHostAction,
  toggleProxyHostAction,
  updateProxyHostAction,
} from '../../app/(dashboard)/proxy-hosts/actions';
import { toggleL4ProxyHostAction, updateL4ProxyHostAction } from '../../app/(dashboard)/l4-proxy-hosts/actions';
import ProxyHostsPage from '../../app/(dashboard)/proxy-hosts/page';
import * as faRoute from '../../app/api/v1/proxy-hosts/[id]/forward-auth-access/route';
import * as rulesRoute from '../../app/api/v1/proxy-hosts/[id]/mtls-access-rules/route';
import * as ruleRoute from '../../app/api/v1/proxy-hosts/[id]/mtls-access-rules/[ruleId]/route';
import * as approveRoute from '../../app/api/v1/change-requests/[id]/approve/route';
import { first } from '@/src/lib/db/ops';

const PASSPHRASE = 'correct horse battery staple';
const APPROVAL_REQUIRED = /is protected by the change approval policy "Production"/;

let tokens: Tokens;
let hosts: Hosts;

beforeEach(async () => {
  ctx.db = createTestDb();
  vi.clearAllMocks();
  vi.mocked(applyCaddyConfig).mockResolvedValue(undefined as never);
  setTrustedLicenseKeysForTests(licenseSigner.keys);
  await installLicense(ctx.db, 'enterprise');
  ({ tokens, hosts } = await seedApprovals(ctx.db));
  await insertPolicy(ctx.db, { name: 'Production' });
});

afterAll(() => setTrustedLicenseKeysForTests(null));

const approve = (id: number) => approveRoute.POST(apiRequest('POST', '/x', tokens.bob), idParams(id));

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

async function requestCount(): Promise<number> {
  return (await ctx.db.select().from(schema.changeRequests)).length;
}

describe('dashboard server actions', () => {
  it('submit change requests for protected hosts and say so', async () => {
    ctx.sessionUserId = ALICE;
    const updated = await updateProxyHostAction(hosts.prod, undefined, form({ name: 'Renamed', changeNote: 'Ticket CHG-7' }));
    expect(updated).toMatchObject({
      status: 'success',
      message: expect.stringMatching(/^Submitted for approval as change request #\d+: it needs 1 approval/),
      changeRequest: { status: 'pending' },
    });
    expect((await hostRow(ctx.db, hosts.prod))!.name).toBe('App');
    expect(await requestRow(ctx.db, updated.changeRequest!.id)).toMatchObject({ note: 'Ticket CHG-7', requestedBy: ALICE });

    expect(await toggleProxyHostAction(hosts.prod, false)).toMatchObject({ status: 'success', changeRequest: { status: 'pending' } });
    expect((await hostRow(ctx.db, hosts.prod))!.enabled).toBe(true);
    expect(await deleteProxyHostAction(hosts.prod, undefined, new FormData())).toMatchObject({ changeRequest: { status: 'pending' } });
    expect(await hostRow(ctx.db, hosts.prod)).toBeDefined();
    const created = await createProxyHostAction(undefined, form({ name: 'From form', domains: 'form.example.com', upstreams: 'backend:8080', tags: 'prod' }));
    expect(created).toMatchObject({ changeRequest: { status: 'pending' } });
    expect(await first(ctx.db.select().from(schema.proxyHosts).where(eq(schema.proxyHosts.name, 'From form')).limit(1))).toBeUndefined();
    expect(await toggleL4ProxyHostAction(hosts.l4prod, false)).toMatchObject({ changeRequest: { status: 'pending' } });
    expect(await updateL4ProxyHostAction(hosts.l4prod, undefined, form({ name: 'Renamed db', protocol: 'tcp' }))).toMatchObject({ changeRequest: { status: 'pending' } });
    expect((await l4Row(ctx.db, hosts.l4prod))!.name).toBe('Database');

    // Unprotected hosts change as before.
    expect(await toggleProxyHostAction(hosts.dev, false)).toEqual({ status: 'success', message: 'Proxy host disabled.' });
    expect((await hostRow(ctx.db, hosts.dev))!.enabled).toBe(false);

    // The approved form change is applied as the requester submitted it.
    expect((await json(await approve(updated.changeRequest!.id))).status).toBe('applied');
    expect((await hostRow(ctx.db, hosts.prod))!.name).toBe('Renamed');
  });

  it('carry the forward-auth grants of the host form into the change request', async () => {
    ctx.sessionUserId = ALICE;
    const data = form({
      name: 'App',
      ingressiForwardAuthPresent: '1',
      ingressiForwardAuthEnabledPresent: '1',
      ingressiForwardAuthEnabled: 'on',
      ingressiFaUserId: String(BOB),
    });
    const submitted = await updateProxyHostAction(hosts.prod, undefined, data);
    expect(submitted).toMatchObject({ changeRequest: { status: 'pending' } });
    expect(await ctx.db.select().from(schema.forwardAuthAccess)).toHaveLength(0);

    expect((await json(await approve(submitted.changeRequest!.id))).status).toBe('applied');
    expect(await ctx.db.select().from(schema.forwardAuthAccess)).toMatchObject([{ proxyHostId: hosts.prod, userId: BOB }]);
  });

  it('apply an emergency change at once for a user allowed to, with a reason', async () => {
    ctx.sessionUserId = ALICE;
    const refused = await updateProxyHostAction(hosts.prod, undefined, form({ name: 'Now', emergencyReason: 'Outage INC-1234 needs it' }));
    expect(refused).toMatchObject({ status: 'error', message: 'Emergency changes need the approvals:emergency permission' });
    expect(await requestCount()).toBe(0);

    ctx.sessionUserId = ADMIN;
    expect(await updateProxyHostAction(hosts.prod, undefined, form({ name: 'Now', emergencyReason: 'too short' }))).toMatchObject({ status: 'error' });
    const applied = await updateProxyHostAction(hosts.prod, undefined, form({ name: 'Now', emergencyReason: 'Outage INC-1234 needs it' }));
    expect(applied).toMatchObject({ status: 'success', message: expect.stringMatching(/^Emergency change applied/), changeRequest: { status: 'applied' } });
    expect((await hostRow(ctx.db, hosts.prod))!.name).toBe('Now');
    expect(await requestRow(ctx.db, applied.changeRequest!.id)).toMatchObject({ emergency: true, emergencyBy: ADMIN, emergencyReason: 'Outage INC-1234 needs it' });
  });

  it('tell the host dialogs which policies there are', async () => {
    ctx.sessionUserId = ALICE;
    const page = await ProxyHostsPage({ searchParams: Promise.resolve({}) }) as { props: { approval: { policies: Array<{ name: string; hostTags: string[] }>; canEmergency: boolean } } };
    expect(page.props.approval.canEmergency).toBe(false);
    expect(page.props.approval.policies).toMatchObject([{ name: 'Production', hostTags: ['prod'] }]);
  });
});

describe('forward-auth access and mTLS access rules', () => {
  it('route changes on a protected host through change requests', async () => {
    const fa = await faRoute.PUT(apiRequest('PUT', '/x', tokens.alice, { userIds: [BOB], groupIds: [] }), idParams(hosts.prod));
    expect(fa.status).toBe(202);
    const faRequest = await json(fa);
    expect(faRequest.changes).toEqual([{ path: 'forwardAuthAccess.userIds', before: [], after: [BOB] }]);
    expect(await ctx.db.select().from(schema.forwardAuthAccess)).toHaveLength(0);
    expect((await json(await approve(faRequest.id))).status).toBe('applied');
    expect(await ctx.db.select().from(schema.forwardAuthAccess)).toMatchObject([{ proxyHostId: hosts.prod, userId: BOB }]);

    const create = await rulesRoute.POST(apiRequest('POST', '/x', tokens.alice, { pathPattern: '/admin/*', denyAll: true }), idParams(hosts.prod));
    expect(create.status).toBe(202);
    expect(await ctx.db.select().from(schema.mtlsAccessRules)).toHaveLength(0);
    expect((await json(await approve((await json(create)).id))).status).toBe('applied');
    const [rule] = await ctx.db.select().from(schema.mtlsAccessRules);
    expect(rule).toMatchObject({ proxyHostId: hosts.prod, pathPattern: '/admin/*', denyAll: true });

    const remove = await ruleRoute.DELETE(apiRequest('DELETE', '/x', tokens.alice), { params: Promise.resolve({ id: String(hosts.prod), ruleId: String(rule.id) }) });
    expect(remove.status).toBe(202);
    expect((await json(await approve((await json(remove)).id))).status).toBe('applied');
    expect(await ctx.db.select().from(schema.mtlsAccessRules)).toHaveLength(0);

    // On an unprotected host they change directly.
    expect((await faRoute.PUT(apiRequest('PUT', '/x', tokens.alice, { userIds: [BOB] }), idParams(hosts.dev))).status).toBe(200);
  });
});

describe('paths refused while a policy covers the host', () => {
  it('direct model calls (every other caller)', async () => {
    await expect(updateProxyHost(hosts.prod, { name: 'Sneaky' }, ADMIN)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(APPROVAL_REQUIRED) });
    await expect(createProxyHost({ name: 'Tagged', domains: ['t.example.com'], upstreams: ['b:80'], tags: ['prod'] }, ADMIN)).rejects.toMatchObject({ status: 409 });
    await expect(deleteL4ProxyHost(hosts.l4prod, ADMIN)).rejects.toMatchObject({ status: 409 });
    expect((await hostRow(ctx.db, hosts.prod))!.name).toBe('App');
    expect(await l4Row(ctx.db, hosts.l4prod)).toBeDefined();
    // Unprotected hosts are unaffected.
    await expect(createProxyHost({ name: 'Free', domains: ['f.example.com'], upstreams: ['b:80'], tags: ['dev'] }, ADMIN)).resolves.toMatchObject({ name: 'Free' });
    await expect(updateL4ProxyHost(hosts.l4dev, { name: 'Renamed' }, ADMIN)).resolves.toMatchObject({ name: 'Renamed' });
  });

  it('WAF rule suppression for a host (WAF page and AI tuning suggestions)', async () => {
    await expect(suppressWafRuleForHost(942100, 'app.example.com', ADMIN)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(APPROVAL_REQUIRED) });
    expect(JSON.parse((await hostRow(ctx.db, hosts.prod))!.meta ?? '{}').waf).toBeUndefined();
    await expect(suppressWafRuleForHost(942100, 'dev.example.com', ADMIN)).resolves.toMatchObject({ name: 'Dev' });
  });

  it('configuration import (and backup restore, which imports the same way)', async () => {
    const { file } = await exportConfiguration(PASSPHRASE, ADMIN);
    // The same configuration again changes no protected host.
    await expect(importConfiguration({ file, passphrase: PASSPHRASE, userId: ADMIN })).resolves.toMatchObject({ warning: null });

    // One that renames or drops the protected host is refused, and nothing is written.
    const renamed = structuredClone(file);
    renamed.content.tables.proxyHosts.find((row) => row.id === hosts.prod)!.name = 'Imported';
    renamed.content.tables.proxyHosts.find((row) => row.id === hosts.dev)!.name = 'Dev imported';
    await expect(importConfiguration({ file: renamed, passphrase: PASSPHRASE, userId: ADMIN }))
      .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/would change hosts protected by the change approval policy "Production": proxy host "Imported"\. Nothing was changed/) });
    expect((await hostRow(ctx.db, hosts.prod))!.name).toBe('App');
    expect((await hostRow(ctx.db, hosts.dev))!.name).toBe('Dev');

    const dropped = structuredClone(file);
    dropped.content.tables.l4ProxyHosts = dropped.content.tables.l4ProxyHosts.filter((row) => row.id !== hosts.l4prod);
    await expect(importConfiguration({ file: dropped, passphrase: PASSPHRASE, userId: ADMIN })).rejects.toMatchObject({ status: 409 });
    expect(await l4Row(ctx.db, hosts.l4prod)).toBeDefined();

    // Changing only unprotected hosts is fine.
    const devOnly = structuredClone(file);
    devOnly.content.tables.proxyHosts.find((row) => row.id === hosts.dev)!.name = 'Dev imported';
    await importConfiguration({ file: devOnly, passphrase: PASSPHRASE, userId: ADMIN });
    expect((await hostRow(ctx.db, hosts.dev))!.name).toBe('Dev imported');
  });

  it('configuration history rollback', async () => {
    const snapshot = await createManualSnapshot(ADMIN);
    await ctx.db.update(schema.proxyHosts).set({ name: 'Changed since' }).where(eq(schema.proxyHosts.id, hosts.prod));
    await expect(restoreSnapshot(snapshot.id, ADMIN)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/would change hosts protected/) });
    expect((await hostRow(ctx.db, hosts.prod))!.name).toBe('Changed since');
    // With the policy disabled (no license needed for that), the rollback goes through.
    await ctx.db.update(schema.approvalPolicies).set({ enabled: false });
    await restoreSnapshot(snapshot.id, ADMIN);
    expect((await hostRow(ctx.db, hosts.prod))!.name).toBe('App');
  });
});

describe('instance sync', () => {
  it('still applies the master\'s configuration on a replica', async () => {
    const payload = await buildSyncPayload();
    const prod = payload.data.proxyHosts.find((row: { id: number }) => row.id === hosts.prod) as { name: string };
    prod.name = 'From master';
    await applySyncPayload(payload);
    expect((await hostRow(ctx.db, hosts.prod))!.name).toBe('From master');
  });
});
