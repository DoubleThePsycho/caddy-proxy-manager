import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/src/lib/models/audit', async (importOriginal) => ({
  parseAuditFilter: (await importOriginal<typeof import('@/src/lib/models/audit')>()).parseAuditFilter,
  queryAuditEvents: vi.fn(),
  countAuditEventsMatching: vi.fn(),
}));

vi.mock('@/src/lib/api-auth', () => {
  const ApiAuthError = class extends Error {
    status: number;
    constructor(msg: string, status: number) { super(msg); this.status = status; this.name = 'ApiAuthError'; }
  };
  return {
    requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
    requireApiAdmin: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
    requireApiUser: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
    apiErrorResponse: vi.fn((error: unknown) => {
      const { NextResponse: NR } = require('next/server');
      if (error instanceof ApiAuthError) {
        return NR.json({ error: error.message }, { status: error.status });
      }
      if (error && typeof (error as { status?: unknown }).status === 'number') {
        return NR.json({ error: (error as Error).message }, { status: (error as { status: number }).status });
      }
      return NR.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 });
    }),
    ApiAuthError,
  };
});

import { GET } from '@/app/api/v1/audit-log/route';
import { queryAuditEvents, countAuditEventsMatching } from '@/src/lib/models/audit';
import { requireApiAdmin } from '@/src/lib/api-auth';

const mockListAuditEvents = vi.mocked(queryAuditEvents);
const mockCountAuditEvents = vi.mocked(countAuditEventsMatching);

/** The filter the route passes on when the request names none. */
const NO_FILTER = { search: undefined, from: undefined, to: undefined };
const mockRequireApiAdmin = vi.mocked(requireApiAdmin);

function createMockRequest(options: { searchParams?: string } = {}): any {
  return {
    headers: { get: () => null },
    method: 'GET',
    nextUrl: { pathname: '/api/v1/audit-log', searchParams: new URLSearchParams(options.searchParams ?? '') },
    json: async () => ({}),
  };
}

const sampleEvents = [
  { id: 1, action: 'proxy_host.create', user_id: 1, details: '{}', created_at: '2026-01-01T00:00:00Z' },
  { id: 2, action: 'certificate.create', user_id: 1, details: '{}', created_at: '2026-01-01T01:00:00Z' },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireApiAdmin.mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' });
});

describe('GET /api/v1/audit-log', () => {
  it('returns paginated events with total', async () => {
    mockListAuditEvents.mockResolvedValue(sampleEvents as any);
    mockCountAuditEvents.mockResolvedValue(2);

    const response = await GET(createMockRequest());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.events).toEqual(sampleEvents);
    expect(data.total).toBe(2);
    expect(data.page).toBe(1);
    expect(data.perPage).toBe(50);
    expect(mockListAuditEvents).toHaveBeenCalledWith(NO_FILTER, { limit: 50, offset: 0 });
    expect(mockCountAuditEvents).toHaveBeenCalledWith(NO_FILTER);
  });

  it('parses page and per_page params', async () => {
    mockListAuditEvents.mockResolvedValue([]);
    mockCountAuditEvents.mockResolvedValue(100);

    const response = await GET(createMockRequest({ searchParams: 'page=3&per_page=25' }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.page).toBe(3);
    expect(data.perPage).toBe(25);
    expect(mockListAuditEvents).toHaveBeenCalledWith(NO_FILTER, { limit: 25, offset: 50 });
  });

  it('passes search param through', async () => {
    mockListAuditEvents.mockResolvedValue([]);
    mockCountAuditEvents.mockResolvedValue(0);

    await GET(createMockRequest({ searchParams: 'search=proxy' }));

    expect(mockListAuditEvents).toHaveBeenCalledWith({ ...NO_FILTER, search: 'proxy' }, { limit: 50, offset: 0 });
    expect(mockCountAuditEvents).toHaveBeenCalledWith({ ...NO_FILTER, search: 'proxy' });
  });

  it('passes the actor, action, entity and time range filters through', async () => {
    mockListAuditEvents.mockResolvedValue([]);
    mockCountAuditEvents.mockResolvedValue(0);

    await GET(createMockRequest({ searchParams: 'actor=7&action=update&entityType=proxy_host&entityId=12&from=2026-10-01&to=2026-10-02' }));

    expect(mockListAuditEvents).toHaveBeenCalledWith(
      {
        ...NO_FILTER,
        actor: 7,
        action: 'update',
        entityType: 'proxy_host',
        entityId: 12,
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-02T23:59:59.999Z',
      },
      { limit: 50, offset: 0 }
    );
  });

  it('filters events no user recorded with actor=system', async () => {
    mockListAuditEvents.mockResolvedValue([]);
    mockCountAuditEvents.mockResolvedValue(0);

    await GET(createMockRequest({ searchParams: 'actor=system' }));

    expect(mockCountAuditEvents).toHaveBeenCalledWith({ ...NO_FILTER, actor: 'system' });
  });

  it.each([
    ['actor=alice', 'actor'],
    ['entityId=abc', 'entityId'],
    ['from=yesterday', 'from'],
    ['from=2026-10-03&to=2026-10-01', 'from must not be after to'],
    ['action=drop%20table', 'action'],
    ['entityType=proxy%27host', 'entityType'],
  ])('refuses %s', async (query, message) => {
    const response = await GET(createMockRequest({ searchParams: query }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(message);
    expect(mockListAuditEvents).not.toHaveBeenCalled();
  });

  it('clamps per_page to max 200', async () => {
    mockListAuditEvents.mockResolvedValue([]);
    mockCountAuditEvents.mockResolvedValue(0);

    await GET(createMockRequest({ searchParams: 'per_page=500' }));

    expect(mockListAuditEvents).toHaveBeenCalledWith(NO_FILTER, { limit: 200, offset: 0 });
  });

  it('clamps per_page to min 1', async () => {
    mockListAuditEvents.mockResolvedValue([]);
    mockCountAuditEvents.mockResolvedValue(0);

    await GET(createMockRequest({ searchParams: 'per_page=0' }));

    expect(mockListAuditEvents).toHaveBeenCalledWith(NO_FILTER, { limit: 50, offset: 0 });
  });

  it('clamps page to min 1', async () => {
    mockListAuditEvents.mockResolvedValue([]);
    mockCountAuditEvents.mockResolvedValue(0);

    await GET(createMockRequest({ searchParams: 'page=-1' }));

    expect(mockListAuditEvents).toHaveBeenCalledWith(NO_FILTER, { limit: 50, offset: 0 });
  });

  it('returns 401 on auth failure', async () => {
    const { ApiAuthError } = await import('@/src/lib/api-auth');
    mockRequireApiAdmin.mockRejectedValue(new ApiAuthError('Unauthorized', 401));

    const response = await GET(createMockRequest());
    expect(response.status).toBe(401);
  });
});
