/**
 * Evidence for access review items (ee/access-reviews/evidence.ts): sign-in
 * sources, last sign-in and sign-ins in 30 days, last change, roles a
 * directory sets, and when each access was last used; and who may read it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb, userId: 1 }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

vi.mock('../../src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-auth')>();
  return {
    ...actual,
    requireApiUser: vi.fn(async () => ({ userId: ctx.userId, role: 'viewer', authMethod: 'bearer' })),
    requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
    requireApiAdmin: vi.fn(async () => ({ userId: ctx.userId, role: 'admin', authMethod: 'bearer' })),
  };
});

import { getCampaignEvidence } from '../../ee/access-reviews/evidence';
import * as reviewerRoute from '../../app/api/v1/access-review-assignments/evidence/route';
import * as adminRoute from '../../app/api/v1/access-reviews/[id]/evidence/route';
import { first } from '@/src/lib/db/ops';

const NOW = new Date('2026-10-03T11:36:00.000Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

type Ids = { campaignId: number; admin: number; ops: number; corp: number; reviewer: number; items: Record<string, number> };

async function seed(): Promise<Ids> {
  const t = ago(300);
  const user = async (email: string, values: Partial<typeof schema.users.$inferInsert> = {}) =>
    (await first(ctx.db.insert(schema.users).values({ email, name: email.split('@')[0], role: 'user', status: 'active', createdAt: t, updatedAt: t, ...values }).returning()))!.id;
  const admin = await user('admin@example.com', { role: 'admin', twoFactorEnabled: true });
  const ops = await user('ops@example.com');
  const corp = await user('corp@example.com', { role: 'admin' });
  const reviewer = await user('reviewer@example.com', { role: 'admin' });

  await ctx.db.insert(schema.oauthProviders).values({ id: 'corp-idp', name: 'Corporate IdP', clientId: 'c', clientSecret: 's', createdAt: t, updatedAt: t });
  const directory = (await first(ctx.db.insert(schema.ldapDirectories).values({
    name: 'Corp directory', url: 'ldaps://ldap.example.com', bindDn: 'cn=svc', bindPassword: 'x', userSearchBase: 'dc=example,dc=com', userSearchFilter: '(uid={username})',
    groupRoleMappings: JSON.stringify([{ group: 'cn=admins,dc=example,dc=com', role: 'admin' }]), createdAt: t, updatedAt: t,
  }).returning()))!;
  const account = async (userId: number, providerId: string, password: string | null = null) =>
    await ctx.db.insert(schema.accounts).values({ userId, accountId: `${userId}-${providerId}`, providerId, password, createdAt: t, updatedAt: t });
  await account(admin, 'credential', 'hash');
  await account(admin, 'corp-idp');
  await account(ops, 'credential', 'hash');
  await account(corp, `ldap:${directory.id}`);
  await ctx.db.insert(schema.scimUsers).values({ userId: ops, userName: 'ops', userNameKey: 'ops', createdAt: t, updatedAt: t });

  const audit = async (userId: number, action: string, entityType: string, summary: string, at: string) =>
    await ctx.db.insert(schema.auditEvents).values({ userId, action, entityType, summary, createdAt: at });
  await audit(admin, 'login_success', 'session', 'User signed in', ago(1));
  await audit(admin, 'login_success', 'session', 'User signed in', ago(10));
  await audit(admin, 'login_success', 'session', 'User signed in', ago(45));
  await audit(admin, 'update', 'proxy_host', 'Changed a rate limit on langfuse.example.com', ago(2));
  await audit(admin, 'audit_log_verified', 'audit_log', 'Verified the chain', ago(0.5));
  await audit(corp, 'login_success', 'session', 'User signed in through an LDAP directory', ago(5));
  await audit(ops, 'forward_auth_login', 'user', 'Forward auth login for user ops@example.com to grafana.example.com', ago(1));
  await audit(ops, 'forward_auth_login', 'user', 'Forward auth login for user ops@example.com to other.example.com', ago(0.2));

  const token = (await first(ctx.db.insert(schema.apiTokens).values({ name: 'backup-script', tokenHash: 'h1', createdBy: admin, createdAt: t, lastUsedAt: ago(0.3) }).returning()))!;
  const unused = (await first(ctx.db.insert(schema.apiTokens).values({ name: 'never', tokenHash: 'h2', createdBy: admin, createdAt: t }).returning()))!;
  const group = (await first(ctx.db.insert(schema.groups).values({ name: 'ops', createdAt: t, updatedAt: t }).returning()))!;
  const empty = (await first(ctx.db.insert(schema.groups).values({ name: 'nothing', createdAt: t, updatedAt: t }).returning()))!;
  const grafana = (await first(ctx.db.insert(schema.proxyHosts).values({ name: 'Grafana', domains: '["grafana.example.com"]', upstreams: '[]', createdAt: t, updatedAt: t }).returning()))!;
  await ctx.db.insert(schema.forwardAuthAccess).values({ proxyHostId: grafana.id, groupId: group.id, createdAt: t });

  const campaign = (await first(ctx.db.insert(schema.accessReviewCampaigns).values({
    name: 'Q4', status: 'open', reviewerIds: JSON.stringify([reviewer]), dueAt: ago(-5), startedAt: ago(1), createdAt: ago(1), updatedAt: ago(1),
  }).returning()))!;
  const item = async (subjectUserId: number, kind: string, targetId: number | null, targetLabel: string) =>
    (await first(ctx.db.insert(schema.accessReviewItems).values({
      campaignId: campaign.id, subjectUserId, subjectEmail: `${subjectUserId}@example.com`, kind, targetId, targetLabel, createdAt: ago(1), updatedAt: ago(1),
    }).returning()))!.id;
  return {
    campaignId: campaign.id, admin, ops, corp, reviewer,
    items: {
      adminAccount: await item(admin, 'account', null, 'account'),
      adminRole: await item(admin, 'role', null, 'Admin role'),
      adminToken: await item(admin, 'api_token', token.id, 'API token backup-script'),
      unusedToken: await item(admin, 'api_token', unused.id, 'API token never'),
      goneToken: await item(admin, 'api_token', 9999, 'API token deleted'),
      opsGroup: await item(ops, 'group', group.id, 'group ops'),
      opsEmpty: await item(ops, 'group', empty.id, 'group nothing'),
      corpRole: await item(corp, 'role', null, 'Admin role'),
      opsRole: await item(ops, 'role', null, 'User role'),
    },
  };
}

let ids: Ids;

beforeEach(async () => {
  ctx.db = createTestDb();
  ids = await seed();
});

describe('evidence', () => {
  it('describes each person: sources, MFA, sign-ins, last change and roles a directory sets', async () => {
    const evidence = await getCampaignEvidence(ids.campaignId, NOW);
    const subject = (userId: number) => evidence.subjects.find((entry) => entry.userId === userId)!;
    expect(subject(ids.admin)).toMatchObject({
      exists: true,
      status: 'active',
      sources: [{ kind: 'local', label: 'Password' }, { kind: 'oidc', label: 'Corporate IdP' }],
      mfa: true,
      lastSignIn: { at: ago(1), summary: 'User signed in' },
      signInsLast30Days: 2,
      // Verifying the audit log is no change; the rate limit is.
      lastChange: { action: 'update', entityType: 'proxy_host', summary: 'Changed a rate limit on langfuse.example.com', at: ago(2) },
      roleManagedBy: null,
    });
    expect(subject(ids.corp)).toMatchObject({ sources: [{ kind: 'ldap', label: 'Corp directory' }], roleManagedBy: 'Corp directory sets the role at each sign-in' });
    expect(subject(ids.ops)).toMatchObject({ sources: [{ kind: 'local', label: 'Password' }, { kind: 'scim', label: 'SCIM provisioning' }], lastSignIn: null, lastChange: null });
  });

  it('says when each access was last used', async () => {
    const evidence = await getCampaignEvidence(ids.campaignId, NOW);
    const item = (key: string) => evidence.items.find((entry) => entry.itemId === ids.items[key])!;
    expect(item('adminAccount')).toMatchObject({ lastUsed: { at: ago(1), detail: '2 sign-ins in 30 days' }, note: null });
    expect(item('adminRole')).toMatchObject({ lastUsed: { at: ago(2), detail: 'Changed a rate limit on langfuse.example.com' }, note: null });
    expect(item('adminToken')).toMatchObject({ lastUsed: { at: ago(0.3), detail: 'API request' }, note: null });
    expect(item('unusedToken')).toMatchObject({ lastUsed: null, note: 'Never used' });
    expect(item('goneToken')).toMatchObject({ note: 'The token no longer exists' });
    // Only sign-ins to hosts the group grants count.
    expect(item('opsGroup')).toMatchObject({ lastUsed: { at: ago(1), detail: 'Forward-auth sign-in to grafana.example.com' } });
    expect(item('opsEmpty')).toMatchObject({ lastUsed: null, note: 'The group grants no host' });
    expect(item('corpRole').note).toBe('Corp directory sets the role at each sign-in');
    expect(item('opsRole')).toMatchObject({ lastUsed: null, note: 'No change in the last 90 days' });
  });

  it('answers 404 for a campaign that does not exist', async () => {
    await expect(getCampaignEvidence(999, NOW)).rejects.toThrow('Access review not found');
  });
});

describe('who may read it', () => {
  const req = (path: string) => new NextRequest(`http://localhost${path}`);

  it('lets a reviewer of the open campaign read it, and nobody else', async () => {
    ctx.userId = ids.reviewer;
    const ok = await reviewerRoute.GET(req(`/api/v1/access-review-assignments/evidence?campaignId=${ids.campaignId}`));
    expect(ok.status).toBe(200);
    expect((await ok.json()).items).toHaveLength(Object.keys(ids.items).length);

    ctx.userId = ids.ops;
    expect((await reviewerRoute.GET(req(`/api/v1/access-review-assignments/evidence?campaignId=${ids.campaignId}`))).status).toBe(404);
    ctx.userId = ids.reviewer;
    expect((await reviewerRoute.GET(req('/api/v1/access-review-assignments/evidence?campaignId=abc'))).status).toBe(404);
    await ctx.db.update(schema.accessReviewCampaigns).set({ status: 'completed' });
    expect((await reviewerRoute.GET(req(`/api/v1/access-review-assignments/evidence?campaignId=${ids.campaignId}`))).status).toBe(404);
  });

  it('serves any campaign to access_reviews:read', async () => {
    ctx.userId = ids.admin;
    const response = await adminRoute.GET(req(`/api/v1/access-reviews/${ids.campaignId}/evidence`), { params: Promise.resolve({ id: String(ids.campaignId) }) });
    expect(response.status).toBe(200);
    expect((await response.json()).campaignId).toBe(ids.campaignId);
  });
});
