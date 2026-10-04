/**
 * Access reviews: campaigns, reviewers' decisions, revocations through the
 * model functions, records, schedules, overdue alerts and the license gate.
 *
 *  - starting a campaign or setting up a schedule needs "access_reviews";
 *    completing, cancelling, deleting, disabling schedules and reviewers'
 *    decisions never do;
 *  - a campaign snapshots every access (account, role, groups, API tokens)
 *    of the active users in scope;
 *  - reviewers need no permission, only to be named; a reviewer never
 *    decides on their own access; other users see nothing;
 *  - confirming applies revocations once, with the last-administrator guard,
 *    and records what happened; the last confirmation completes the campaign;
 *  - the record downloads as CSV (formula-safe) or JSON.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { installLicense, licenseSigner } from '../helpers/config-fixture';
import { idParams, insertApiToken, insertLocalUser, now } from '../helpers/scim';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

vi.mock('../../src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-auth')>();
  return { ...actual, requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))), requireApiAdmin: vi.fn() };
});

import { requireApiAdmin } from '../../src/lib/api-auth';
import { logAuditEvent } from '../../src/lib/audit';
import { setTrustedLicenseKeysForTests } from '../../ee/licensing/public-keys';
import { isAdminLevel, PERMISSION_AREAS } from '../../src/lib/permissions';
import { addMonths, runDueSchedules } from '../../ee/access-reviews/schedules';
import { pendingReviewSummary } from '../../ee/access-reviews/decisions';
import { evaluateAccessReviewOverdue, evaluateAccessReviewStarted } from '../../ee/alerting/evaluators';
import { createAlertRule } from '../../ee/alerting/rules';
import * as campaignsRoute from '../../app/api/v1/access-reviews/route';
import * as campaignRoute from '../../app/api/v1/access-reviews/[id]/route';
import * as completeRoute from '../../app/api/v1/access-reviews/[id]/complete/route';
import * as cancelRoute from '../../app/api/v1/access-reviews/[id]/cancel/route';
import * as recordRoute from '../../app/api/v1/access-reviews/[id]/record/route';
import * as schedulesRoute from '../../app/api/v1/access-review-schedules/route';
import * as scheduleRoute from '../../app/api/v1/access-review-schedules/[id]/route';
import * as assignmentsRoute from '../../app/api/v1/access-review-assignments/route';
import * as assignmentRoute from '../../app/api/v1/access-review-assignments/[id]/route';
import * as confirmRoute from '../../app/api/v1/access-review-assignments/confirm/route';
import { first as dbFirst } from '@/src/lib/db/ops';

const LICENSE_ERROR = 'Access reviews needs an active Ingressi Enterprise license or higher';
const ADMIN_ID = 1;

type Fixture = {
  reviewerA: number; reviewerB: number; outsider: number;
  adminSubject: number; customSubject: number; plainSubject: number;
  roleId: number; groupId: number; tokenId: number;
  tokens: { reviewerA: string; reviewerB: string; outsider: string };
};
let fx: Fixture;

function req(method: string, path: string, payload?: unknown, bearer?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (payload !== undefined) headers['content-type'] = 'application/json';
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return new NextRequest(`http://localhost${path}`, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
}

function dueIn(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

async function removeLicense() {
  await ctx.db.delete(schema.settings).where(eq(schema.settings.key, 'license'));
}

async function start(payload: Record<string, unknown> = {}) {
  const response = await campaignsRoute.POST(req('POST', '/x', {
    name: 'Q4 review', reviewerIds: [fx.reviewerA, fx.reviewerB], dueAt: dueIn(14), ...payload,
  }));
  return { response, json: await response.json() };
}

async function assignments(bearer: string) {
  return (await assignmentsRoute.GET(req('GET', '/x', undefined, bearer))).json();
}

async function decide(bearer: string, itemId: number, decision: 'keep' | 'revoke' | null, comment?: string) {
  return assignmentRoute.PUT(req('PUT', '/x', { decision, ...(comment ? { comment } : {}) }, bearer), idParams(itemId));
}

async function confirm(bearer: string, campaignId: number) {
  return confirmRoute.POST(req('POST', '/x', { campaignId }, bearer));
}

function item(campaign: { items: any[] }, subject: number, kind: string) {
  return campaign.items.find((entry) => entry.subjectUserId === subject && entry.kind === kind);
}

async function campaignDetail(id: number) {
  return (await campaignRoute.GET(req('GET', '/x'), idParams(id))).json();
}

beforeEach(async () => {
  ctx.db = createTestDb();
  vi.clearAllMocks();
  setTrustedLicenseKeysForTests(licenseSigner.keys);
  await installLicense(ctx.db, 'enterprise');
  await insertLocalUser(ctx.db, { id: ADMIN_ID, email: 'admin@localhost', role: 'admin' });
  vi.mocked(requireApiAdmin).mockResolvedValue({ userId: ADMIN_ID, role: 'admin', authMethod: 'bearer' });

  const role = (await dbFirst(ctx.db.insert(schema.customRoles).values({ name: 'Operators', permissions: '["proxy_hosts:read"]', createdAt: now(), updatedAt: now() }).returning()))!;
  const reviewerA = await insertLocalUser(ctx.db, { email: 'reviewer.a@example.com' });
  const reviewerB = await insertLocalUser(ctx.db, { email: 'reviewer.b@example.com' });
  const outsider = await insertLocalUser(ctx.db, { email: 'outsider@example.com' });
  const adminSubject = await insertLocalUser(ctx.db, { email: 'second.admin@example.com', role: 'admin' });
  const customSubject = await insertLocalUser(ctx.db, { email: 'operator@example.com', role: 'viewer', customRoleId: role.id });
  const plainSubject = await insertLocalUser(ctx.db, { email: 'plain@example.com' });
  const group = (await dbFirst(ctx.db.insert(schema.groups).values({ name: 'Finance', createdAt: now(), updatedAt: now() }).returning()))!;
  await ctx.db.insert(schema.groupMembers).values({ groupId: group.id, userId: adminSubject, createdAt: now() });
  await insertApiToken(ctx.db, adminSubject);
  const tokenId = (await dbFirst(ctx.db.select().from(schema.apiTokens).where(eq(schema.apiTokens.createdBy, adminSubject)).limit(1)))!.id;
  fx = {
    reviewerA, reviewerB, outsider, adminSubject, customSubject, plainSubject, roleId: role.id, groupId: group.id, tokenId,
    tokens: { reviewerA: await insertApiToken(ctx.db, reviewerA), reviewerB: await insertApiToken(ctx.db, reviewerB), outsider: await insertApiToken(ctx.db, outsider) },
  };
});

afterAll(() => setTrustedLicenseKeysForTests(null));

describe('license gate', () => {
  it('refuses starting and scheduling without a license', async () => {
    await removeLicense();
    const started = await start();
    expect(started.response.status).toBe(403);
    expect(started.json.error).toBe(LICENSE_ERROR);
    const scheduled = await schedulesRoute.POST(req('POST', '/x', { name: 'Quarterly', reviewerIds: [fx.reviewerA, fx.reviewerB] }));
    expect(scheduled.status).toBe(403);
    expect(await ctx.db.select().from(schema.accessReviewCampaigns)).toEqual([]);
  });

  it('refuses changing or re-enabling a schedule without a license, but disabling and deleting work', async () => {
    const created = await (await schedulesRoute.POST(req('POST', '/x', { name: 'Quarterly', reviewerIds: [fx.reviewerA, fx.reviewerB] }))).json();
    await removeLicense();
    expect((await scheduleRoute.PUT(req('PUT', '/x', { name: 'Renamed' }), idParams(created.id))).status).toBe(403);
    expect((await scheduleRoute.PUT(req('PUT', '/x', { enabled: false }), idParams(created.id))).status).toBe(200);
    expect((await scheduleRoute.PUT(req('PUT', '/x', { enabled: true }), idParams(created.id))).status).toBe(403);
    expect((await scheduleRoute.DELETE(req('DELETE', '/x'), idParams(created.id))).status).toBe(204);
  });

  it('lets reviewers decide and admins complete, cancel and delete without a license', async () => {
    const { json: a } = await start();
    const { json: b } = await start({ name: 'Second' });
    const { json: c } = await start({ name: 'Third' });
    await removeLicense();
    const target = item(a, fx.plainSubject, 'account');
    expect((await decide(fx.tokens.reviewerA, target.id, 'keep')).status).toBe(200);
    expect((await confirm(fx.tokens.reviewerA, a.id)).status).toBe(200);
    expect((await completeRoute.POST(req('POST', '/x'), idParams(a.id))).status).toBe(200);
    expect((await cancelRoute.POST(req('POST', '/x'), idParams(b.id))).status).toBe(200);
    expect((await campaignRoute.DELETE(req('DELETE', '/x'), idParams(c.id))).status).toBe(204);
    // Scheduled runs never check the license either.
    const schedule = (await dbFirst(ctx.db.insert(schema.accessReviewSchedules).values({
      name: 'Lapsed', scope: '{"type":"all"}', reviewerIds: JSON.stringify([fx.reviewerA, fx.reviewerB]),
      nextRunAt: new Date(Date.now() - 1000).toISOString(), createdAt: now(), updatedAt: now(),
    }).returning()))!;
    expect(await runDueSchedules()).toEqual({ started: 1, failed: 0 });
    expect(await ctx.db.select().from(schema.accessReviewCampaigns).where(eq(schema.accessReviewCampaigns.scheduleId, schedule.id))).toHaveLength(1);
  });
});

describe('starting a campaign', () => {
  it('snapshots every access of the active users in scope', async () => {
    await ctx.db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, fx.outsider));
    const { response, json } = await start();
    expect(response.status).toBe(201);
    expect(json.status).toBe('open');
    const subjects = new Set(json.items.map((entry: { subjectUserId: number }) => entry.subjectUserId));
    expect(subjects.has(fx.outsider)).toBe(false);
    expect(subjects.has(ADMIN_ID)).toBe(true);
    expect(json.items.filter((entry: any) => entry.subjectUserId === fx.adminSubject).map((entry: any) => entry.kind).sort())
      .toEqual(['account', 'api_token', 'group', 'role']);
    expect(item(json, fx.adminSubject, 'role').targetLabel).toBe('Administrator (built-in role)');
    expect(item(json, fx.adminSubject, 'group')).toMatchObject({ targetId: fx.groupId, targetLabel: 'Group "Finance"' });
    expect(item(json, fx.adminSubject, 'api_token').targetId).toBe(fx.tokenId);
    expect(item(json, fx.customSubject, 'role')).toMatchObject({ targetId: fx.roleId, targetLabel: 'Custom role "Operators"' });
    expect(item(json, fx.plainSubject, 'role')).toBeUndefined();
    expect(json.counts.pending).toBe(json.items.length);
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(expect.objectContaining({ action: 'access_review_started', entityType: 'access_review', entityId: json.id }));
  });

  it('limits the scope to chosen roles, custom roles and groups', async () => {
    const subjectsOf = (json: any) => [...new Set(json.items.map((entry: any) => entry.subjectUserId))].sort();
    expect(subjectsOf((await start({ scope: { type: 'filter', roles: ['admin'] } })).json)).toEqual([ADMIN_ID, fx.adminSubject].sort());
    expect(subjectsOf((await start({ scope: { type: 'filter', customRoleIds: [fx.roleId] } })).json)).toEqual([fx.customSubject]);
    expect(subjectsOf((await start({ scope: { type: 'filter', groupIds: [fx.groupId] } })).json)).toEqual([fx.adminSubject]);
  });

  it('validates the request', async () => {
    const cases: Record<string, unknown>[] = [
      { reviewerIds: [fx.reviewerA] }, // reviewer A is in scope and the only reviewer
      { scope: { type: 'filter', roles: ['viewer'], customRoleIds: [] } }, // only the custom-role user, stored as viewer, is excluded
      { dueAt: '2001-01-01T00:00:00.000Z' },
      { dueAt: dueIn(400) },
      { reviewerIds: [] },
      { reviewerIds: [999] },
      { scope: { type: 'filter' } },
      { scope: { type: 'filter', groupIds: [999] } },
      { surprise: true },
    ];
    for (const payload of cases) {
      const { response } = await start(payload);
      expect(response.status, JSON.stringify(payload)).toBe(400);
    }
    await ctx.db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, fx.reviewerB));
    expect((await start()).response.status).toBe(400);
  });
});

describe('reviewing', () => {
  it('shows reviewers their campaigns, marks their own access, and hides them from everyone else', async () => {
    const { json } = await start();
    const mine = await assignments(fx.tokens.reviewerA);
    expect(mine).toHaveLength(1);
    expect(mine[0].campaign.id).toBe(json.id);
    expect(mine[0].items.filter((entry: any) => entry.ownAccess).every((entry: any) => entry.subjectUserId === fx.reviewerA)).toBe(true);
    expect(await assignments(fx.tokens.outsider)).toEqual([]);
    const target = item(json, fx.plainSubject, 'account');
    expect((await decide(fx.tokens.outsider, target.id, 'revoke')).status).toBe(404);
    expect((await pendingReviewSummary(fx.reviewerA)).pending).toBe(json.items.filter((entry: any) => entry.subjectUserId !== fx.reviewerA).length);
  });

  it('refuses reviewing one\'s own access', async () => {
    const { json } = await start();
    const own = item(json, fx.reviewerA, 'account');
    const response = await decide(fx.tokens.reviewerA, own.id, 'keep');
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe('You cannot review your own access');
    // The other reviewer can.
    expect((await decide(fx.tokens.reviewerB, own.id, 'keep')).status).toBe(200);
  });

  it('applies confirmed revocations through the model functions, once', async () => {
    const later = new Date(Date.now() + 3_600_000).toISOString();
    await ctx.db.insert(schema.sessions).values({ userId: fx.plainSubject, token: 'plain-session', expiresAt: later, createdAt: now(), updatedAt: now() });
    const { json } = await start();
    const revoke = [
      item(json, fx.adminSubject, 'role'),
      item(json, fx.adminSubject, 'group'),
      item(json, fx.adminSubject, 'api_token'),
      item(json, fx.customSubject, 'role'),
      item(json, fx.plainSubject, 'account'),
    ];
    for (const entry of revoke) expect((await decide(fx.tokens.reviewerA, entry.id, 'revoke', 'No longer needed')).status).toBe(200);
    expect((await decide(fx.tokens.reviewerA, item(json, fx.adminSubject, 'account').id, 'keep')).status).toBe(200);

    // Drafts change nothing.
    expect((await dbFirst(ctx.db.select().from(schema.users).where(eq(schema.users.id, fx.adminSubject)).limit(1)))?.role).toBe('admin');

    const response = await confirm(fx.tokens.reviewerA, json.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ confirmed: 6, kept: 1, revoked: 5, failed: 0, unchanged: 0, campaignCompleted: false });

    const user = async (id: number) => (await dbFirst(ctx.db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1)))!;
    expect(await user(fx.adminSubject)).toMatchObject({ role: 'viewer', customRoleId: null, status: 'active' });
    expect(await user(fx.customSubject)).toMatchObject({ role: 'viewer', customRoleId: null });
    expect((await user(fx.plainSubject)).status).toBe('disabled');
    expect(await ctx.db.select().from(schema.sessions).where(eq(schema.sessions.userId, fx.plainSubject))).toEqual([]);
    expect(await ctx.db.select().from(schema.groupMembers).where(eq(schema.groupMembers.userId, fx.adminSubject))).toEqual([]);
    expect(await dbFirst(ctx.db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, fx.tokenId)).limit(1))).toBeUndefined();

    const detail = await campaignDetail(json.id);
    expect(item(detail, fx.adminSubject, 'role')).toMatchObject({ outcome: 'revoked', decidedByEmail: 'reviewer.a@example.com', comment: 'No longer needed' });
    expect(vi.mocked(logAuditEvent).mock.calls.filter(([event]) => event.action === 'access_review_revoke')).toHaveLength(5);

    // Confirming again applies nothing; confirmed items cannot change.
    expect((await confirm(fx.tokens.reviewerA, json.id)).status).toBe(400);
    expect((await decide(fx.tokens.reviewerA, item(json, fx.adminSubject, 'role').id, 'keep')).status).toBe(409);
  });

  it('records access that is already gone as unchanged and a guard refusal as failed', async () => {
    // Only the primary admin is an administrator.
    await ctx.db.update(schema.users).set({ role: 'user' }).where(eq(schema.users.id, fx.adminSubject));
    const { json } = await start();
    await ctx.db.delete(schema.groupMembers);
    await decide(fx.tokens.reviewerA, item(json, fx.adminSubject, 'group').id, 'revoke');
    await decide(fx.tokens.reviewerA, item(json, ADMIN_ID, 'role').id, 'revoke');
    const result = await (await confirm(fx.tokens.reviewerA, json.id)).json();
    expect(result).toMatchObject({ revoked: 0, unchanged: 1, failed: 1 });
    expect((await dbFirst(ctx.db.select().from(schema.users).where(eq(schema.users.id, ADMIN_ID)).limit(1)))?.role).toBe('admin');
    const detail = await campaignDetail(json.id);
    expect(item(detail, ADMIN_ID, 'role')).toMatchObject({ outcome: 'failed', outcomeDetail: 'This change would leave no active administrator' });
  });

  it('completes the campaign with its last confirmation', async () => {
    const { json } = await start({ scope: { type: 'filter', customRoleIds: [fx.roleId] } });
    for (const entry of json.items) await decide(fx.tokens.reviewerB, entry.id, 'keep');
    const result = await (await confirm(fx.tokens.reviewerB, json.id)).json();
    expect(result.campaignCompleted).toBe(true);
    expect((await campaignDetail(json.id)).status).toBe('completed');
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(expect.objectContaining({ action: 'access_review_completed', entityId: json.id }));
    expect(await assignments(fx.tokens.reviewerB)).toEqual([]);
  });
});

describe('closing campaigns', () => {
  it('records undecided items as not reviewed when completed early', async () => {
    const { json } = await start();
    const done = await (await completeRoute.POST(req('POST', '/x'), idParams(json.id))).json();
    expect(done.status).toBe('completed');
    expect(done.counts.notReviewed).toBe(json.items.length);
    expect((await completeRoute.POST(req('POST', '/x'), idParams(json.id))).status).toBe(409);
  });

  it('stops decisions when cancelled', async () => {
    const { json } = await start();
    const target = item(json, fx.plainSubject, 'account');
    await decide(fx.tokens.reviewerA, target.id, 'revoke');
    await cancelRoute.POST(req('POST', '/x'), idParams(json.id));
    expect((await confirm(fx.tokens.reviewerA, json.id)).status).toBe(409);
    expect((await dbFirst(ctx.db.select().from(schema.users).where(eq(schema.users.id, fx.plainSubject)).limit(1)))?.status).toBe('active');
  });
});

describe('records', () => {
  it('downloads a formula-safe CSV and a JSON record', async () => {
    const { json } = await start({ name: '=HYPERLINK("http://example.com")' });
    await decide(fx.tokens.reviewerA, item(json, fx.plainSubject, 'account').id, 'keep', '+1 looks fine');
    const csv = await recordRoute.GET(req('GET', `/x?format=csv`), idParams(json.id));
    expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(csv.headers.get('content-disposition')).toMatch(/^attachment; filename="access-review-\d+-hyperlink-http-example-com\.csv"$/);
    const text = await csv.text();
    expect(text.split('\r\n')[0]).toBe('campaign_id,campaign_name,campaign_status,due_at,user_id,user_email,user_name,access_type,access,decision,comment,reviewer_email,decided_at,confirmed_at,outcome,outcome_detail');
    expect(text).toContain(`"'=HYPERLINK(""http://example.com"")"`);
    expect(text).toContain("'+1 looks fine");
    expect(text.trim().split('\r\n')).toHaveLength(json.items.length + 1);

    const record = await (await recordRoute.GET(req('GET', `/x?format=json`), idParams(json.id))).json();
    expect(record.campaign.id).toBe(json.id);
    expect(record.items).toHaveLength(json.items.length);
    expect((await recordRoute.GET(req('GET', `/x?format=xml`), idParams(json.id))).status).toBe(400);
  });
});

describe('overdue and alerting', () => {
  it('flags overdue campaigns and items and raises alert findings', async () => {
    const { json } = await start();
    let started = await evaluateAccessReviewStarted();
    expect(started.status === 'ok' && started.findings.map((finding) => finding.subjectKey)).toEqual([`access_review:${json.id}`]);
    let overdue = await evaluateAccessReviewOverdue(new Date());
    expect(overdue.status === 'ok' && overdue.findings).toEqual([]);

    await ctx.db.update(schema.accessReviewCampaigns).set({ dueAt: '2020-01-01T00:00:00.000Z' }).where(eq(schema.accessReviewCampaigns.id, json.id));
    const detail = await campaignDetail(json.id);
    expect(detail.overdue).toBe(true);
    expect(detail.items.every((entry: any) => entry.overdue)).toBe(true);
    overdue = await evaluateAccessReviewOverdue(new Date());
    expect(overdue.status === 'ok' && overdue.findings[0]).toMatchObject({ subjectKey: `access_review:${json.id}`, severity: 'warning' });

    await cancelRoute.POST(req('POST', '/x'), idParams(json.id));
    started = await evaluateAccessReviewStarted();
    expect(started.status === 'ok' && started.findings).toEqual([]);
  });

  it('accepts the access review rule types', async () => {
    const rule = await createAlertRule({ name: 'Overdue reviews', type: 'access_review_overdue' }, ADMIN_ID);
    expect(rule).toMatchObject({ type: 'access_review_overdue', params: {} });
    await expect(createAlertRule({ name: 'Bad', type: 'access_review_started', params: { days: 1 } }, ADMIN_ID)).rejects.toThrow(/params/);
  });
});

describe('schedules', () => {
  it('starts the first campaign at once and the next one after the interval', async () => {
    const response = await schedulesRoute.POST(req('POST', '/x', {
      name: 'Quarterly', reviewerIds: [fx.reviewerA, fx.reviewerB], intervalMonths: 3, durationDays: 10,
    }));
    expect(response.status).toBe(201);
    const schedule = await response.json();
    expect(schedule.lastCampaignId).toBeTruthy();
    const first = (await dbFirst(ctx.db.select().from(schema.accessReviewCampaigns).where(eq(schema.accessReviewCampaigns.id, schedule.lastCampaignId)).limit(1)))!;
    expect(first.scheduleId).toBe(schedule.id);
    expect(new Date(first.dueAt).getTime() - new Date(first.startedAt).getTime()).toBeCloseTo(10 * 86_400_000, -4);
    const next = new Date(schedule.nextRunAt);
    expect(next.getTime()).toBeGreaterThan(Date.now() + 80 * 86_400_000);

    expect(await runDueSchedules(new Date())).toEqual({ started: 0, failed: 0 });
    expect(await runDueSchedules(new Date(next.getTime() + 1000))).toEqual({ started: 1, failed: 0 });
    expect(await ctx.db.select().from(schema.accessReviewCampaigns).where(eq(schema.accessReviewCampaigns.scheduleId, schedule.id))).toHaveLength(2);
  });

  it('records why a scheduled run could not start and moves on', async () => {
    const emptyGroup = (await dbFirst(ctx.db.insert(schema.groups).values({ name: 'Empty', createdAt: now(), updatedAt: now() }).returning()))!;
    const row = (await dbFirst(ctx.db.insert(schema.accessReviewSchedules).values({
      name: 'Nobody', scope: JSON.stringify({ type: 'filter', roles: [], customRoleIds: [], groupIds: [emptyGroup.id] }),
      reviewerIds: JSON.stringify([fx.reviewerA]), nextRunAt: new Date(Date.now() - 1000).toISOString(), createdAt: now(), updatedAt: now(),
    }).returning()))!;
    expect(await runDueSchedules()).toEqual({ started: 0, failed: 1 });
    const after = (await dbFirst(ctx.db.select().from(schema.accessReviewSchedules).where(eq(schema.accessReviewSchedules.id, row.id)).limit(1)))!;
    expect(after.lastError).toBe('No active user is in the scope of this review');
    expect(new Date(after.nextRunAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses a schedule whose only reviewer would review themselves', async () => {
    const response = await schedulesRoute.POST(req('POST', '/x', { name: 'Solo', reviewerIds: [fx.reviewerA] }));
    expect(response.status).toBe(400);
  });

  it('adds calendar months, clamping to the month\'s last day', () => {
    expect(addMonths(new Date('2027-01-31T09:00:00.000Z'), 1).toISOString()).toBe('2027-02-28T09:00:00.000Z');
    expect(addMonths(new Date('2027-11-15T09:00:00.000Z'), 3).toISOString()).toBe('2028-02-15T09:00:00.000Z');
  });
});

describe('permissions', () => {
  it('has a paid access_reviews area whose write is administrator-level', () => {
    expect(PERMISSION_AREAS.access_reviews).toMatchObject({ actions: ['read', 'write'], paid: true });
    expect(isAdminLevel(['access_reviews:write'])).toBe(true);
    expect(isAdminLevel(['access_reviews:read'])).toBe(false);
  });
});
