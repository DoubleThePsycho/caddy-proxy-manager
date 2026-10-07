/**
 * Change approvals (ee/approvals) through the REST API, with real API tokens,
 * the real permission guards and custom roles: managing policies, four-eyes
 * (self-approval refused, distinct approvers), staleness and the re-checks of the requester at apply
 * time, change windows and the scheduler, expiry, emergency changes, request
 * visibility within a role's scope, the audit trail and the approval_pending
 * alert.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { apiRequest, idParams, json } from '../helpers/custom-roles';
import {
  ADMIN, ALICE, BOB, CAROL, ROLE_OPERATORS,
  accessOf, hostRow, l4Row, requestRow, seedApprovals, type Hosts, type Tokens,
} from '../helpers/approvals';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { applyCaddyConfig } from '../../src/lib/caddy';
import { logAuditEvent } from '../../src/lib/audit';
import { isAdminLevel } from '../../src/lib/permissions';
import * as policiesRoute from '../../app/api/v1/approval-policies/route';
import * as policyRoute from '../../app/api/v1/approval-policies/[id]/route';
import * as requestsRoute from '../../app/api/v1/change-requests/route';
import * as requestRoute from '../../app/api/v1/change-requests/[id]/route';
import * as approveRoute from '../../app/api/v1/change-requests/[id]/approve/route';
import * as rejectRoute from '../../app/api/v1/change-requests/[id]/reject/route';
import * as cancelRoute from '../../app/api/v1/change-requests/[id]/cancel/route';
import * as commentsRoute from '../../app/api/v1/change-requests/[id]/comments/route';
import * as applyRoute from '../../app/api/v1/change-requests/[id]/apply/route';
import * as emergencyRoute from '../../app/api/v1/change-requests/[id]/emergency/route';
import * as hostsRoute from '../../app/api/v1/proxy-hosts/route';
import * as hostRoute from '../../app/api/v1/proxy-hosts/[id]/route';
import * as l4sRoute from '../../app/api/v1/l4-proxy-hosts/route';
import * as l4Route from '../../app/api/v1/l4-proxy-hosts/[id]/route';
import { GET as getOpenApi } from '../../app/api/v1/openapi.json/route';
import {
  applyChangeRequestNow,
  applyDueChangeRequests,
  approveChangeRequest,
  expireDueRequests,
  gateHostChange,
  getChangeRequest,
} from '../../ee/approvals/requests';
import { evaluateApprovalPending } from '../../ee/alerting/evaluators';
import { createAlertRule } from '../../ee/alerting/rules';
import { first as dbFirst } from '@/src/lib/db/ops';

let tokens: Tokens;
let hosts: Hosts;

beforeEach(async () => {
  ctx.db = createTestDb();
  vi.clearAllMocks();
  vi.mocked(applyCaddyConfig).mockResolvedValue(undefined as never);
  ({ tokens, hosts } = await seedApprovals(ctx.db));
});

async function createPolicy(body: Record<string, unknown> = {}) {
  const response = await policiesRoute.POST(apiRequest('POST', '/api/v1/approval-policies', tokens.admin, { name: 'Production', hostTags: ['prod'], ...body }));
  expect(response.status).toBe(201);
  return json(response);
}

/** ALICE renames the prod host; returns the change request (202). */
async function requestRename(name = 'Renamed', token = tokens.alice, hostId = hosts.prod) {
  const response = await hostRoute.PUT(apiRequest('PUT', '/x', token, { name }), idParams(hostId));
  expect(response.status).toBe(202);
  return json(response);
}

const approve = (id: number, token: string, body?: unknown) => approveRoute.POST(apiRequest('POST', '/x', token, body), idParams(id));

function auditActions(): string[] {
  return vi.mocked(logAuditEvent).mock.calls.map(([event]) => event.action);
}

describe('approval policies', () => {
  it('creates, reads, changes, disables, enables and deletes a policy', async () => {
    const policy = await createPolicy();
    expect((await policiesRoute.GET(apiRequest('GET', '/x', tokens.admin))).status).toBe(200);
    expect((await policyRoute.GET(apiRequest('GET', '/x', tokens.admin), idParams(policy.id))).status).toBe(200);
    const changed = await policyRoute.PUT(apiRequest('PUT', '/x', tokens.admin, { requiredApprovals: 2 }), idParams(policy.id));
    expect(changed.status).toBe(200);
    expect((await json(changed)).requiredApprovals).toBe(2);
    const disabled = await policyRoute.PUT(apiRequest('PUT', '/x', tokens.admin, { enabled: false }), idParams(policy.id));
    expect(disabled.status).toBe(200);
    expect((await json(disabled)).enabled).toBe(false);
    const enabled = await policyRoute.PUT(apiRequest('PUT', '/x', tokens.admin, { enabled: true }), idParams(policy.id));
    expect(enabled.status).toBe(200);
    expect((await json(enabled)).enabled).toBe(true);
    expect((await policyRoute.DELETE(apiRequest('DELETE', '/x', tokens.admin), idParams(policy.id))).status).toBe(204);
    expect(await ctx.db.select().from(schema.approvalPolicies)).toHaveLength(0);
  });

  it('is managed with approvals:manage, which is administrator-level', async () => {
    const response = await policiesRoute.POST(apiRequest('POST', '/x', tokens.alice, { name: 'Mine' }));
    expect(response.status).toBe(403);
    expect((await json(response)).error).toBe('Permission required: approvals:manage');
    expect(isAdminLevel(['approvals:manage'])).toBe(true);
    expect(isAdminLevel(['approvals:emergency'])).toBe(true);
    expect(isAdminLevel(['approvals:approve'])).toBe(false);
    expect(isAdminLevel(['users:write', 'approvals:approve'])).toBe(true);
  });

  it('validates the policy and fills in defaults', async () => {
    const policy = await createPolicy({ windows: [{ days: ['friday', 'monday'], start: '09:00', end: '17:00' }], timeZone: 'Europe/Rome' });
    expect(policy).toMatchObject({
      name: 'Production',
      enabled: true,
      targetTypes: ['proxy_host', 'l4_proxy_host'],
      operations: ['create', 'update', 'delete', 'enable', 'disable'],
      hostTags: ['prod'],
      requiredApprovals: 1,
      allowEmergency: true,
      timeZone: 'Europe/Rome',
      windows: [{ days: ['monday', 'friday'], start: '09:00', end: '17:00' }],
      requestTtlHours: 72,
    });
    const bad: Record<string, unknown>[] = [
      { name: '' },
      { name: 'X', unknown: true },
      { name: 'X', requiredApprovals: 0 },
      { name: 'X', requiredApprovals: 11 },
      { name: 'X', operations: [] },
      { name: 'X', operations: ['rename'] },
      { name: 'X', targetTypes: ['certificate'] },
      { name: 'X', hostTags: ['Not A Tag!'] },
      { name: 'X', timeZone: 'Mars/Olympus' },
      { name: 'X', windows: [{ days: ['monday'], start: '9', end: '17:00' }] },
      { name: 'X', requestTtlHours: 10_000 },
    ];
    for (const body of bad) {
      const response = await policiesRoute.POST(apiRequest('POST', '/x', tokens.admin, body));
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    const duplicate = await policiesRoute.POST(apiRequest('POST', '/x', tokens.admin, { name: 'production' }));
    expect(duplicate.status).toBe(409);
    expect(auditActions()).toContain('create');
  });
});

describe('four-eyes', () => {
  it('stores a change request instead of changing a protected host, and leaves other hosts alone', async () => {
    await createPolicy();
    const request = await requestRename();
    expect(request).toMatchObject({
      targetType: 'proxy_host',
      targetId: hosts.prod,
      targetName: 'Renamed',
      operation: 'update',
      status: 'pending',
      requiredApprovals: 1,
      approvals: 0,
      requestedBy: { id: ALICE, name: `User ${ALICE}` },
      policies: [{ name: 'Production' }],
      viewer: { isRequester: true, canApprove: false, canCancel: true },
    });
    expect(request.changes).toEqual([{ path: 'host.name', before: 'App', after: 'Renamed' }]);
    expect((await hostRow(ctx.db, hosts.prod))!.name).toBe('App');
    expect(applyCaddyConfig).not.toHaveBeenCalled();

    // A host the policy does not cover changes directly.
    const direct = await hostRoute.PUT(apiRequest('PUT', '/x', tokens.alice, { name: 'Dev 2' }), idParams(hosts.dev));
    expect(direct.status).toBe(200);
    expect((await hostRow(ctx.db, hosts.dev))!.name).toBe('Dev 2');
  });

  it('never lets the requester approve their own change, and applies it with another approval', async () => {
    await createPolicy();
    const request = await requestRename();

    const own = await approve(request.id, tokens.alice);
    expect(own.status).toBe(403);
    expect((await json(own)).error).toMatch(/cannot approve your own change request/);
    const noPermission = await approve(request.id, tokens.dave);
    expect(noPermission.status).toBe(403);
    expect((await json(noPermission)).error).toBe('Permission required: approvals:approve');
    expect((await hostRow(ctx.db, hosts.prod))!.name).toBe('App');

    const response = await approve(request.id, tokens.bob, { comment: 'Looks good' });
    expect(response.status).toBe(200);
    const applied = await json(response);
    expect(applied).toMatchObject({ status: 'applied', approvals: 1, appliedBy: { id: BOB } });
    expect(applied.reviews).toMatchObject([{ userId: BOB, decision: 'approve', comment: 'Looks good' }]);
    expect((await hostRow(ctx.db, hosts.prod))!.name).toBe('Renamed');

    // The audit log names the requester and the approvers; the host change itself is the requester's.
    const events = vi.mocked(logAuditEvent).mock.calls.map(([event]) => event);
    expect(events.find((event) => event.action === 'change_request_created')).toMatchObject({ userId: ALICE, entityId: request.id });
    expect(events.find((event) => event.action === 'change_request_approved')).toMatchObject({ userId: BOB });
    expect(events.find((event) => event.action === 'update' && event.entityType === 'proxy_host')).toMatchObject({ userId: ALICE });
    expect(events.find((event) => event.action === 'change_request_applied')).toMatchObject({
      userId: BOB,
      data: expect.objectContaining({ requestedBy: ALICE, approvedBy: [BOB], emergency: false }),
    });
  });

  it('gates administrators too', async () => {
    await createPolicy();
    const response = await hostRoute.PUT(apiRequest('PUT', '/x', tokens.admin, { name: 'By admin' }), idParams(hosts.prod));
    expect(response.status).toBe(202);
    const request = await json(response);
    expect((await approve(request.id, tokens.admin)).status).toBe(403);
    expect((await json(await approve(request.id, tokens.alice))).status).toBe('applied');
  });

  it('needs distinct approvers', async () => {
    await createPolicy({ requiredApprovals: 2 });
    const request = await requestRename();
    expect((await json(await approve(request.id, tokens.bob))).status).toBe('pending');
    const twice = await approve(request.id, tokens.bob);
    expect(twice.status).toBe(409);
    expect((await hostRow(ctx.db, hosts.prod))!.name).toBe('App');
    const done = await json(await approve(request.id, tokens.carol));
    expect(done).toMatchObject({ status: 'applied', approvals: 2 });
    expect(done.reviews.map((review: { userId: number }) => review.userId)).toEqual([BOB, CAROL]);
  });

  it('takes the strictest of several policies and re-reads them when approving', async () => {
    await createPolicy({ name: 'All hosts', hostTags: [] });
    const strict = await createPolicy({ name: 'Strict', requiredApprovals: 2 });
    const request = await requestRename();
    expect(request.requiredApprovals).toBe(2);
    expect(request.policies.map((policy: { name: string }) => policy.name).sort()).toEqual(['All hosts', 'Strict']);
    // A policy asking more after the request raises what it needs.
    await policyRoute.PUT(apiRequest('PUT', '/x', tokens.admin, { requiredApprovals: 3 }), idParams(strict.id));
    expect((await json(await approve(request.id, tokens.bob))).requiredApprovals).toBe(3);
    expect((await json(await approve(request.id, tokens.carol))).status).toBe('pending');
    expect((await json(await approve(request.id, tokens.admin))).status).toBe('applied');
  });

  it('covers creating, deleting, enabling and disabling hosts, by tag before or after the change', async () => {
    await createPolicy();
    const create = await hostsRoute.POST(apiRequest('POST', '/x', tokens.alice, { name: 'New', domains: ['new.example.com'], upstreams: ['backend:80'], tags: ['prod'] }));
    expect(create.status).toBe(202);
    const created = await json(create);
    expect(created).toMatchObject({ operation: 'create', targetId: null });
    expect(created.changes).toEqual(expect.arrayContaining([{ path: 'host.domains', before: null, after: ['new.example.com'] }]));
    const applied = await json(await approve(created.id, tokens.bob));
    expect(applied.status).toBe('applied');
    expect((await hostRow(ctx.db, applied.targetId))!.name).toBe('New');

    // Tagging an unprotected host with a protected tag needs approval too.
    expect((await hostRoute.PUT(apiRequest('PUT', '/x', tokens.alice, { tags: ['dev', 'prod'] }), idParams(hosts.dev))).status).toBe(202);
    // And so does taking the tag away.
    expect((await hostRoute.PUT(apiRequest('PUT', '/x', tokens.alice, { tags: [] }), idParams(hosts.prod))).status).toBe(202);

    const toggle = await json(await hostRoute.PUT(apiRequest('PUT', '/x', tokens.alice, { enabled: false }), idParams(hosts.prod)));
    expect(toggle).toMatchObject({ operation: 'disable', operations: ['disable'] });

    const remove = await hostRoute.DELETE(apiRequest('DELETE', '/x', tokens.alice), idParams(hosts.prod));
    expect(remove.status).toBe(202);
    const removal = await json(remove);
    expect(removal.operation).toBe('delete');
    expect(removal.changes).toEqual(expect.arrayContaining([{ path: 'host.name', before: 'App', after: null }]));
    expect(await hostRow(ctx.db, hosts.prod)).toBeDefined();
    expect((await json(await approve(removal.id, tokens.bob))).status).toBe('applied');
    expect(await hostRow(ctx.db, hosts.prod)).toBeUndefined();
  });

  it('only covers the operations a policy lists', async () => {
    await createPolicy({ operations: ['delete'] });
    expect((await hostRoute.PUT(apiRequest('PUT', '/x', tokens.alice, { enabled: false }), idParams(hosts.prod))).status).toBe(200);
    expect((await hostRoute.DELETE(apiRequest('DELETE', '/x', tokens.alice), idParams(hosts.prod))).status).toBe(202);
  });

  it('protects L4 proxy hosts', async () => {
    await createPolicy({ targetTypes: ['l4_proxy_host'] });
    expect((await hostRoute.PUT(apiRequest('PUT', '/x', tokens.alice, { name: 'Direct' }), idParams(hosts.prod))).status).toBe(200);
    const update = await l4Route.PUT(apiRequest('PUT', '/x', tokens.alice, { upstreams: ['db2:5432'] }), idParams(hosts.l4prod));
    expect(update.status).toBe(202);
    const request = await json(update);
    expect(request.changes).toEqual([{ path: 'host.upstreams', before: ['db:5432'], after: ['db2:5432'] }]);
    expect((await json(await approve(request.id, tokens.bob))).status).toBe('applied');
    expect(JSON.parse((await l4Row(ctx.db, hosts.l4prod))!.upstreams)).toEqual(['db2:5432']);
    const create = await l4sRoute.POST(apiRequest('POST', '/x', tokens.alice, { name: 'Cache', protocol: 'tcp', listenAddress: ':6379', upstreams: ['cache:6379'], tags: ['prod'] }));
    expect(create.status).toBe(202);
    expect((await l4Route.DELETE(apiRequest('DELETE', '/x', tokens.alice), idParams(hosts.l4dev))).status).toBe(200);
  });
});

describe('rejecting, cancelling and commenting', () => {
  it('rejects with a comment, never the requester', async () => {
    await createPolicy();
    const request = await requestRename();
    expect((await rejectRoute.POST(apiRequest('POST', '/x', tokens.bob, {}), idParams(request.id))).status).toBe(400);
    expect((await rejectRoute.POST(apiRequest('POST', '/x', tokens.alice, { comment: 'nah' }), idParams(request.id))).status).toBe(403);
    const rejected = await json(await rejectRoute.POST(apiRequest('POST', '/x', tokens.bob, { comment: 'Wrong upstream' }), idParams(request.id)));
    expect(rejected).toMatchObject({ status: 'rejected', reviews: [{ decision: 'reject', comment: 'Wrong upstream' }] });
    expect((await approve(request.id, tokens.carol)).status).toBe(409);
    expect((await hostRow(ctx.db, hosts.prod))!.name).toBe('App');
    expect(auditActions()).toContain('change_request_rejected');
  });

  it('lets the requester or an administrator cancel', async () => {
    await createPolicy();
    const first = await requestRename();
    expect((await cancelRoute.POST(apiRequest('POST', '/x', tokens.bob), idParams(first.id))).status).toBe(403);
    expect((await json(await cancelRoute.POST(apiRequest('POST', '/x', tokens.alice), idParams(first.id)))).status).toBe('cancelled');
    const second = await requestRename('Again');
    expect((await json(await cancelRoute.POST(apiRequest('POST', '/x', tokens.admin, { comment: 'Superseded' }), idParams(second.id)))).status).toBe('cancelled');
    expect((await cancelRoute.POST(apiRequest('POST', '/x', tokens.alice), idParams(second.id))).status).toBe(409);
  });

  it('takes comments from anyone who can see the request', async () => {
    await createPolicy();
    const request = await requestRename();
    const response = await commentsRoute.POST(apiRequest('POST', '/x', tokens.dave, { comment: 'Which ticket?' }), idParams(request.id));
    expect(response.status).toBe(201);
    expect((await json(response)).reviews).toMatchObject([{ decision: 'comment', comment: 'Which ticket?' }]);
    expect((await commentsRoute.POST(apiRequest('POST', '/x', tokens.dave, { comment: '' }), idParams(request.id))).status).toBe(400);
  });
});

describe('visibility', () => {
  it('shows requests only on hosts the caller can read within its scope, and the caller\'s own', async () => {
    await createPolicy();
    const prod = await requestRename();
    const teamB = await requestRename('Team B renamed', tokens.alice, hosts.teamB);
    const list = async (token: string, query = '') =>
      (await json(await requestsRoute.GET(apiRequest('GET', `/api/v1/change-requests${query}`, token)))).requests.map((r: { id: number }) => r.id);
    expect(await list(tokens.bob)).toEqual([teamB.id, prod.id]);
    expect(await list(tokens.erin)).toEqual([teamB.id]);
    expect((await requestRoute.GET(apiRequest('GET', '/x', tokens.erin), idParams(prod.id))).status).toBe(404);
    expect((await approve(prod.id, tokens.erin)).status).toBe(404);
    expect((await json(await approve(teamB.id, tokens.erin))).status).toBe('applied');
    expect(await list(tokens.bob, '?status=open')).toEqual([prod.id]);
    expect(await list(tokens.bob, '?status=applied')).toEqual([teamB.id]);
    expect((await requestsRoute.GET(apiRequest('GET', '/api/v1/change-requests?status=bogus', tokens.bob))).status).toBe(400);
  });
});

describe('applying re-checks the request', () => {
  it('fails a request whose host changed after it was made', async () => {
    await createPolicy();
    const request = await requestRename();
    await ctx.db.update(schema.proxyHosts).set({ upstreams: '["other:80"]', updatedAt: new Date(Date.now() + 1000).toISOString() })
      .where(eq(schema.proxyHosts.id, hosts.prod));
    const result = await json(await approve(request.id, tokens.bob));
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/changed after this request was made/);
    expect((await hostRow(ctx.db, hosts.prod))!.name).toBe('App');
    expect(auditActions()).toContain('change_request_failed');
  });

  it('fails when the requester lost the permission or was disabled', async () => {
    await createPolicy();
    const first = await requestRename();
    await ctx.db.update(schema.customRoles).set({ permissions: JSON.stringify(['proxy_hosts:read', 'approvals:read']) })
      .where(eq(schema.customRoles.id, ROLE_OPERATORS));
    const lost = await json(await approve(first.id, tokens.bob));
    expect(lost).toMatchObject({ status: 'failed', error: expect.stringMatching(/no longer holds the proxy_hosts:write permission/) });

    await ctx.db.update(schema.customRoles).set({ permissions: JSON.stringify(['proxy_hosts:read', 'proxy_hosts:write', 'approvals:read']) })
      .where(eq(schema.customRoles.id, ROLE_OPERATORS));
    const second = await requestRename('Second');
    await ctx.db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, ALICE));
    const disabled = await json(await approve(second.id, tokens.bob));
    expect(disabled).toMatchObject({ status: 'failed', error: "The requester's account is no longer active" });
    expect((await hostRow(ctx.db, hosts.prod))!.name).toBe('App');
  });

  it('fails when the host left the requester\'s tag scope', async () => {
    await createPolicy();
    await ctx.db.update(schema.customRoles).set({ scopeTags: '["prod"]' }).where(eq(schema.customRoles.id, ROLE_OPERATORS));
    const request = await requestRename();
    await ctx.db.update(schema.customRoles).set({ scopeTags: '["other"]' }).where(eq(schema.customRoles.id, ROLE_OPERATORS));
    const result = await json(await approve(request.id, tokens.bob));
    expect(result).toMatchObject({ status: 'failed', error: expect.stringMatching(/no longer within the requester's scope/) });
  });

  it('marks a change Caddy did not take as applied with a warning', async () => {
    await createPolicy();
    const request = await requestRename();
    const { CaddyApplyError } = await import('../../src/lib/caddy-apply-error');
    vi.mocked(applyCaddyConfig).mockRejectedValueOnce(new CaddyApplyError('Unable to reach Caddy API', 'CADDY_UNREACHABLE'));
    const result = await json(await approve(request.id, tokens.bob));
    expect(result).toMatchObject({ status: 'applied', error: expect.stringMatching(/Unable to reach Caddy API/) });
    expect((await hostRow(ctx.db, hosts.prod))!.name).toBe('Renamed');
  });
});

describe('change windows', () => {
  // Monday 5 October 2026: 09:00–17:00 in Rome is 07:00–15:00Z.
  const closed = new Date('2026-10-05T05:00:00Z');
  const open = new Date('2026-10-05T08:00:00Z');

  async function windowedRequest() {
    await createPolicy({ timeZone: 'Europe/Rome', windows: [{ days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], start: '09:00', end: '17:00' }] });
    const host = (await dbFirst(ctx.db.select().from(schema.proxyHosts).where(eq(schema.proxyHosts.id, hosts.prod)).limit(1)))!;
    const outcome = await gateHostChange({
      access: await accessOf(ctx.db, ALICE),
      change: { targetType: 'proxy_host', kind: 'update', target: { id: host.id, name: host.name, tags: ['prod'], enabled: true }, input: { host: { name: 'Windowed' } } },
      now: closed,
    });
    expect(outcome?.status).toBe('pending');
    return outcome!.request.id;
  }

  it('waits for the window and is applied by the scheduler when it opens', async () => {
    const id = await windowedRequest();
    const approved = await approveChangeRequest(await accessOf(ctx.db, BOB), id, {}, closed);
    expect(approved.status).toBe('approved');
    expect(approved.window).toMatchObject({ restricted: true, open: false, nextOpenAt: '2026-10-05T07:00:00.000Z' });
    expect((await hostRow(ctx.db, hosts.prod))!.name).toBe('App');

    expect(await applyDueChangeRequests(closed)).toEqual({ expired: 0, applied: 0, failed: 0 });
    expect(await applyDueChangeRequests(open)).toEqual({ expired: 0, applied: 1, failed: 0 });
    expect((await hostRow(ctx.db, hosts.prod))!.name).toBe('Windowed');
    expect(await requestRow(ctx.db, id)).toMatchObject({ status: 'applied', appliedBy: null });
    expect(vi.mocked(logAuditEvent).mock.calls.map(([event]) => event).find((event) => event.action === 'change_request_applied'))
      .toMatchObject({ userId: null, data: expect.objectContaining({ via: 'scheduler', approvedBy: [BOB] }) });
  });

  it('lets an approver apply it inside the window, never outside', async () => {
    const id = await windowedRequest();
    await approveChangeRequest(await accessOf(ctx.db, BOB), id, {}, closed);
    await expect(applyChangeRequestNow(await accessOf(ctx.db, CAROL), id, closed)).rejects.toMatchObject({ status: 409 });
    expect((await getChangeRequest(await accessOf(ctx.db, CAROL), id, open)).viewer.canApply).toBe(true);
    const applied = await applyChangeRequestNow(await accessOf(ctx.db, CAROL), id, open);
    expect(applied).toMatchObject({ status: 'applied', appliedBy: { id: CAROL } });
  });

  it('applies at once when the last approval comes inside the window', async () => {
    const id = await windowedRequest();
    expect((await approveChangeRequest(await accessOf(ctx.db, BOB), id, {}, open)).status).toBe('applied');
  });

  it('refuses applying through the REST endpoint before approval', async () => {
    await createPolicy();
    const request = await requestRename();
    expect((await applyRoute.POST(apiRequest('POST', '/x', tokens.bob), idParams(request.id))).status).toBe(409);
  });
});

describe('expiry', () => {
  it('expires pending requests after the policy\'s time to live', async () => {
    await createPolicy({ requestTtlHours: 1 });
    const request = await requestRename();
    expect(await expireDueRequests(new Date(Date.now() + 30 * 60_000))).toBe(0);
    expect(await expireDueRequests(new Date(Date.now() + 2 * 60 * 60_000))).toBe(1);
    expect((await requestRow(ctx.db, request.id))!.status).toBe('expired');
    expect((await approve(request.id, tokens.bob)).status).toBe(409);
    expect(auditActions()).toContain('change_request_expired');
  });
});

describe('emergency changes', () => {
  it('need approvals:emergency and a reason, and are applied at once and flagged', async () => {
    await createPolicy({ requiredApprovals: 2, windows: [{ days: ['sunday'], start: '03:00', end: '03:01' }] });
    const request = await requestRename();
    const denied = await emergencyRoute.POST(apiRequest('POST', '/x', tokens.alice, { reason: 'Production is down, INC-42' }), idParams(request.id));
    expect(denied.status).toBe(403);
    expect((await json(denied)).error).toBe('Permission required: approvals:emergency');
    expect((await emergencyRoute.POST(apiRequest('POST', '/x', tokens.admin, { reason: 'short' }), idParams(request.id))).status).toBe(400);

    const response = await emergencyRoute.POST(apiRequest('POST', '/x', tokens.admin, { reason: 'Production is down, INC-42' }), idParams(request.id));
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      status: 'applied',
      emergency: true,
      emergencyReason: 'Production is down, INC-42',
      emergencyBy: { id: ADMIN },
      approvals: 0,
    });
    expect((await hostRow(ctx.db, hosts.prod))!.name).toBe('Renamed');
    const events = vi.mocked(logAuditEvent).mock.calls.map(([event]) => event);
    expect(events.find((event) => event.action === 'change_request_emergency')).toMatchObject({ userId: ADMIN, data: expect.objectContaining({ requestedBy: ALICE, reason: 'Production is down, INC-42' }) });
    expect(events.find((event) => event.action === 'change_request_applied')).toMatchObject({ data: expect.objectContaining({ emergency: true, via: 'emergency' }) });
  });

  it('are refused when a covering policy forbids them', async () => {
    await createPolicy({ allowEmergency: false });
    const request = await requestRename();
    const response = await emergencyRoute.POST(apiRequest('POST', '/x', tokens.admin, { reason: 'Production is down, INC-42' }), idParams(request.id));
    expect(response.status).toBe(403);
    expect((await json(response)).error).toBe('The change approval policy "Production" does not allow emergency changes');
    expect((await hostRow(ctx.db, hosts.prod))!.name).toBe('App');
  });
});

describe('approval_pending alerts', () => {
  it('reports each pending request once and resolves it when decided', async () => {
    await createPolicy();
    await createAlertRule({ name: 'Approvals', type: 'approval_pending' }, ADMIN);

    const request = await requestRename();
    const evaluation = await evaluateApprovalPending(new Date());
    expect(evaluation).toMatchObject({ status: 'ok', findings: [{ subjectKey: `change_request:${request.id}`, severity: 'info' }] });
    const finding = evaluation.status === 'ok' ? evaluation.findings[0] : null;
    expect(finding?.title).toMatch(/Change request #\d+ awaits approval: update proxy host "Renamed"/);
    expect(JSON.stringify(finding?.facts)).not.toContain('backend');
    await approve(request.id, tokens.bob);
    expect(await evaluateApprovalPending(new Date())).toEqual({ status: 'ok', findings: [] });
  });
});

describe('OpenAPI', () => {
  it('documents the endpoints and the 202 answers', async () => {
    const spec = await json(await getOpenApi(apiRequest('GET', '/api/v1/openapi.json', tokens.admin)));
    for (const path of [
      '/api/v1/approval-policies', '/api/v1/approval-policies/{id}', '/api/v1/change-requests', '/api/v1/change-requests/{id}',
      '/api/v1/change-requests/{id}/approve', '/api/v1/change-requests/{id}/reject', '/api/v1/change-requests/{id}/cancel',
      '/api/v1/change-requests/{id}/comments', '/api/v1/change-requests/{id}/apply', '/api/v1/change-requests/{id}/emergency',
    ]) {
      expect(spec.paths[path], path).toBeDefined();
    }
    expect(spec.paths['/api/v1/proxy-hosts/{id}'].put.responses['202']).toEqual({ $ref: '#/components/responses/ChangeRequestSubmitted' });
    expect(spec.components.responses.ChangeRequestSubmitted).toBeDefined();
    expect(spec.components.schemas.ChangeRequest).toBeDefined();
    // Every reference of the approval endpoints and schemas resolves.
    const docs = {
      paths: Object.entries(spec.paths).filter(([path]) => /approval-policies|change-requests/.test(path)),
      schemas: ['ApprovalPolicy', 'ApprovalPolicyInput', 'ChangeRequest', 'ChangeRequestPage'].map((name) => spec.components.schemas[name]),
      response: spec.components.responses.ChangeRequestSubmitted,
    };
    const refs = JSON.stringify(docs).match(/"\$ref":"#\/components\/[^"]+"/g) ?? [];
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of new Set(refs)) {
      const path = JSON.parse(`{${ref}}`).$ref.slice('#/'.length).split('/');
      expect(path.reduce((node: any, key: string) => node?.[key], spec), ref).toBeDefined();
    }
  });
});
