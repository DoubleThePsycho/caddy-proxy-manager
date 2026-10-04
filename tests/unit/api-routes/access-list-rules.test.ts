/**
 * REST routes of access list rules, the Blocked sources list and the stats
 * (app/api/v1/access-lists/...): each names its permission, passes what the
 * models need, maps errors (a malformed body is 400, an organisation user on
 * the Blocked sources list is 403), and answers 201 only for a new block.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adminAccess, organizationAccess, type Access } from '@/src/lib/permissions';

const ctx = vi.hoisted(() => ({ access: null as unknown as Access, denied: null as null | { message: string; status: number } }));

vi.mock('@/src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/lib/api-auth')>();
  return {
    ...actual,
    requireApiPermission: vi.fn(async (_request: unknown, permission: string) => {
      if (ctx.denied) throw new actual.ApiAuthError(ctx.denied.message, ctx.denied.status);
      return { userId: ctx.access.userId, role: 'admin', authMethod: 'bearer', access: ctx.access, permission };
    }),
  };
});

vi.mock('@/src/lib/models/access-lists', () => ({
  addAccessListRule: vi.fn(),
  replaceAccessListRules: vi.fn(),
  updateAccessListRule: vi.fn(),
  removeAccessListRule: vi.fn(),
  reorderAccessListRules: vi.fn(),
  addBlockedSource: vi.fn(),
  removeBlockedSource: vi.fn(),
  getBlockedSourcesList: vi.fn(),
  ensureBlockedSourcesList: vi.fn(),
  updateAccessList: vi.fn(),
  blockedSourcesPlaceholder: vi.fn(() => ({ id: null, name: 'Blocked sources', system: 'blocked_sources', rules: [] })),
}));

vi.mock('@/src/lib/access-scope', () => ({ findAccessListInScope: vi.fn() }));
vi.mock('@/src/lib/access-list-overview', () => ({ loadAccessListOverview: vi.fn() }));

import { requireApiPermission } from '@/src/lib/api-auth';
import * as models from '@/src/lib/models/access-lists';
import { findAccessListInScope } from '@/src/lib/access-scope';
import { loadAccessListOverview } from '@/src/lib/access-list-overview';
import { ApiValidationError } from '@/src/lib/api-errors';
import * as rulesRoute from '@/app/api/v1/access-lists/[id]/rules/route';
import * as ruleRoute from '@/app/api/v1/access-lists/[id]/rules/[ruleId]/route';
import * as reorderRoute from '@/app/api/v1/access-lists/[id]/rules/reorder/route';
import * as blockedRoute from '@/app/api/v1/access-lists/blocked-sources/route';
import * as entriesRoute from '@/app/api/v1/access-lists/blocked-sources/entries/route';
import * as entryRoute from '@/app/api/v1/access-lists/blocked-sources/entries/[entryId]/route';
import * as statsRoute from '@/app/api/v1/access-lists/stats/route';

function request(body?: unknown, options: { malformed?: boolean; search?: string } = {}): any {
  return {
    headers: { get: () => null },
    nextUrl: { pathname: '/api/v1/access-lists/x', searchParams: new URLSearchParams(options.search ?? '') },
    json: async () => {
      if (options.malformed) throw new SyntaxError('Unexpected token');
      return body ?? {};
    },
  };
}

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
const rule = { id: 4, position: 0, action: 'deny', kind: 'ip', values: ['198.51.100.19'], note: null, expiresAt: null, expired: false };

beforeEach(() => {
  vi.clearAllMocks();
  ctx.access = adminAccess(1);
  ctx.denied = null;
});

describe('permissions', () => {
  it('names access_lists:read for reads and access_lists:write for changes', async () => {
    vi.mocked(findAccessListInScope).mockResolvedValue({ rules: [rule] } as never);
    vi.mocked(models.getBlockedSourcesList).mockResolvedValue(null);
    vi.mocked(loadAccessListOverview).mockResolvedValue({
      lists: [], usage: {}, blockedSources: null, blockedSourcesVisible: true,
      stats: { available: false, windowSeconds: 86400, stopped: 0, previous: 0, requests: null, failedSignIns: 0, byOutcome: null, lists: {}, blockedSources: null, countries: [], hosts: [] },
    });
    const calls: Array<[string, () => Promise<Response>]> = [
      ['access_lists:read', () => rulesRoute.GET(request(), params({ id: '1' }))],
      ['access_lists:write', () => rulesRoute.POST(request(rule), params({ id: '1' }))],
      ['access_lists:write', () => rulesRoute.PUT(request({ rules: [] }), params({ id: '1' }))],
      ['access_lists:read', () => ruleRoute.GET(request(), params({ id: '1', ruleId: '4' }))],
      ['access_lists:write', () => ruleRoute.PUT(request(rule), params({ id: '1', ruleId: '4' }))],
      ['access_lists:write', () => ruleRoute.DELETE(request(), params({ id: '1', ruleId: '4' }))],
      ['access_lists:write', () => reorderRoute.POST(request({ ruleIds: [4] }), params({ id: '1' }))],
      ['access_lists:read', () => blockedRoute.GET(request())],
      ['access_lists:write', () => blockedRoute.PUT(request({ failClosed: true }))],
      ['access_lists:read', () => entriesRoute.GET(request())],
      ['access_lists:write', () => entriesRoute.POST(request({ address: '198.51.100.19' }))],
      ['access_lists:write', () => entryRoute.DELETE(request(), params({ entryId: '4' }))],
      ['access_lists:read', () => statsRoute.GET(request())],
    ];
    vi.mocked(models.addBlockedSource).mockResolvedValue({ entry: rule as never, created: true });
    vi.mocked(models.ensureBlockedSourcesList).mockResolvedValue({ id: 9 } as never);
    for (const [permission, call] of calls) {
      vi.mocked(requireApiPermission).mockClear();
      await call();
      expect(vi.mocked(requireApiPermission).mock.calls[0][1]).toBe(permission);
    }
  });

  it('answers the guard refusal and changes nothing', async () => {
    ctx.denied = { message: 'Permission required: access_lists:write', status: 403 };
    const response = await entriesRoute.POST(request({ address: '198.51.100.19' }));
    expect(response.status).toBe(403);
    expect(models.addBlockedSource).not.toHaveBeenCalled();
  });
});

describe('rules routes', () => {
  it('answers 404 for a list outside the caller scope', async () => {
    vi.mocked(findAccessListInScope).mockResolvedValue(null);
    expect((await rulesRoute.GET(request(), params({ id: '1' }))).status).toBe(404);
    expect((await ruleRoute.GET(request(), params({ id: '1', ruleId: '4' }))).status).toBe(404);
  });

  it('adds a rule at a position and answers 201', async () => {
    vi.mocked(models.addAccessListRule).mockResolvedValue(rule as never);
    const response = await rulesRoute.POST(request({ ...rule, position: 2 }), params({ id: '1' }));
    expect(response.status).toBe(201);
    expect(models.addAccessListRule).toHaveBeenCalledWith(1, expect.objectContaining({ action: 'deny', position: 2 }), 1, { position: 2 });
  });

  it('replaces and reorders with the bodies it was sent', async () => {
    vi.mocked(models.replaceAccessListRules).mockResolvedValue([rule] as never);
    vi.mocked(models.reorderAccessListRules).mockResolvedValue([rule] as never);
    await rulesRoute.PUT(request({ rules: [rule] }), params({ id: '3' }));
    expect(models.replaceAccessListRules).toHaveBeenCalledWith(3, [rule], 1);
    await reorderRoute.POST(request({ ruleIds: [4, 5] }), params({ id: '3' }));
    expect(models.reorderAccessListRules).toHaveBeenCalledWith(3, [4, 5], 1);
  });

  it('answers 400 for a malformed body or a body that is not an object, and passes model validation errors', async () => {
    expect((await rulesRoute.POST(request(undefined, { malformed: true }), params({ id: '1' }))).status).toBe(400);
    expect((await rulesRoute.PUT(request([rule]), params({ id: '1' }))).status).toBe(400);
    vi.mocked(models.updateAccessListRule).mockRejectedValue(new ApiValidationError('rule.values: "nope" is not an IP address or CIDR range'));
    const response = await ruleRoute.PUT(request({ ...rule, values: ['nope'] }), params({ id: '1', ruleId: '4' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'rule.values: "nope" is not an IP address or CIDR range' });
    vi.mocked(models.removeAccessListRule).mockRejectedValue(new Error('Access list rule not found'));
    expect((await ruleRoute.DELETE(request(), params({ id: '1', ruleId: '4' }))).status).toBe(404);
  });
});

describe('Blocked sources routes', () => {
  it('shows the list before its first use without creating it', async () => {
    vi.mocked(models.getBlockedSourcesList).mockResolvedValue(null);
    const response = await blockedRoute.GET(request());
    expect(await response.json()).toMatchObject({ id: null, system: 'blocked_sources' });
    expect(models.ensureBlockedSourcesList).not.toHaveBeenCalled();
  });

  it('answers 201 for a new block and 200 for an address already blocked', async () => {
    vi.mocked(models.addBlockedSource).mockResolvedValueOnce({ entry: rule as never, created: true });
    expect((await entriesRoute.POST(request({ address: '198.51.100.19', reason: 'Scanner' }))).status).toBe(201);
    expect(models.addBlockedSource).toHaveBeenCalledWith({ address: '198.51.100.19', reason: 'Scanner' }, 1);
    vi.mocked(models.addBlockedSource).mockResolvedValueOnce({ entry: rule as never, created: false });
    expect((await entriesRoute.POST(request({ address: '198.51.100.19' }))).status).toBe(200);
  });

  it('refuses organisation users (403) on every Blocked sources route', async () => {
    ctx.access = organizationAccess(5, 2, 'org_admin');
    const responses = await Promise.all([
      blockedRoute.GET(request()),
      blockedRoute.PUT(request({ failClosed: true })),
      entriesRoute.GET(request()),
      entriesRoute.POST(request({ address: '198.51.100.19' })),
      entryRoute.DELETE(request(), params({ entryId: '4' })),
    ]);
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403]);
    expect(models.addBlockedSource).not.toHaveBeenCalled();
    expect(models.ensureBlockedSourcesList).not.toHaveBeenCalled();
    expect(models.removeBlockedSource).not.toHaveBeenCalled();
  });

  it('updates the list it creates on first use', async () => {
    vi.mocked(models.ensureBlockedSourcesList).mockResolvedValue({ id: 9 } as never);
    vi.mocked(models.updateAccessList).mockResolvedValue({ id: 9 } as never);
    await blockedRoute.PUT(request({ denyStatus: 451 }));
    expect(models.updateAccessList).toHaveBeenCalledWith(9, { denyStatus: 451 }, 1);
  });
});

describe('stats route', () => {
  it('reports each list with its hosts and stopped requests, and nothing about Blocked sources for organisation users', async () => {
    vi.mocked(loadAccessListOverview).mockResolvedValue({
      lists: [{ id: 1, name: 'Office', rules: [{ action: 'allow', kind: 'ip' }], entries: [], defaultAction: 'deny', system: null } as never],
      usage: { 1: [{ id: 10, name: 'app', domains: ['app.example.com'], enabled: true }] },
      blockedSources: null,
      blockedSourcesVisible: false,
      stats: {
        available: true, windowSeconds: 86400, stopped: 5, previous: 2, requests: null, failedSignIns: 0, byOutcome: null,
        lists: { 1: { stopped: 5, failedSignIns: 0, hosts: { 10: { stopped: 5, failedSignIns: 0 } } } },
        blockedSources: null, countries: [{ code: 'US', count: 5 }], hosts: [{ host: 'app.example.com', count: 5 }],
      },
    });
    const body = await (await statsRoute.GET(request(undefined, { search: 'organizationId=2' }))).json();
    expect(body).toMatchObject({
      available: true,
      stopped: 5,
      lists: [{ id: 1, type: 'address_allowlist', rules: 1, stopped: 5, hosts: [{ id: 10, stopped: 5, failedSignIns: 0 }] }],
      blockedSources: null,
    });
  });
});
