import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/src/lib/models/api-tokens', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/src/lib/models/api-tokens')>();
  return {
    TOKEN_EXPIRY_PRESETS: original.TOKEN_EXPIRY_PRESETS,
    isTokenExpiryPreset: original.isTokenExpiryPreset,
    expiryFromPreset: original.expiryFromPreset,
    createApiToken: vi.fn(),
    listApiTokens: vi.fn(),
    listAllApiTokens: vi.fn(),
    deleteApiToken: vi.fn(),
    getApiTokenSummary: vi.fn().mockResolvedValue({ name: 'Token', createdBy: 1 }),
  };
});

vi.mock('@/src/lib/api-auth', () => {
  const ApiAuthError = class extends Error {
    status: number;
    constructor(msg: string, status: number) { super(msg); this.status = status; this.name = 'ApiAuthError'; }
  };
  return {
    requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
    requireApiAdmin: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
    requireApiUser: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
    getApiAccess: vi.fn((result: { role: string }) => ({ isAdmin: result.role === 'admin' })),
    apiErrorResponse: vi.fn((error: unknown) => {
      const { NextResponse: NR } = require('next/server');
      if (error instanceof ApiAuthError) {
        return NR.json({ error: error.message }, { status: error.status });
      }
      return NR.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 });
    }),
    ApiAuthError,
  };
});

import { GET, POST } from '@/app/api/v1/tokens/route';
import { DELETE } from '@/app/api/v1/tokens/[id]/route';
import { createApiToken, listApiTokens, listAllApiTokens, deleteApiToken } from '@/src/lib/models/api-tokens';
import { requireApiUser } from '@/src/lib/api-auth';

const mockCreateApiToken = vi.mocked(createApiToken);
const mockListApiTokens = vi.mocked(listApiTokens);
const mockListAllApiTokens = vi.mocked(listAllApiTokens);
const mockDeleteApiToken = vi.mocked(deleteApiToken);
const mockRequireApiUser = vi.mocked(requireApiUser);

function createMockRequest(options: { method?: string; body?: unknown; authorization?: string; searchParams?: string } = {}): any {
  return {
    headers: {
      get(name: string) {
        if (name === 'authorization') return options.authorization ?? 'Bearer test-token';
        return null;
      },
    },
    method: options.method ?? 'GET',
    nextUrl: { pathname: '/api/v1/tokens', searchParams: new URLSearchParams(options.searchParams ?? '') },
    json: async () => options.body ?? {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireApiUser.mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'session' });
});

describe('GET /api/v1/tokens', () => {
  it('returns all tokens for admin', async () => {
    const tokens = [
      { id: 1, name: 'Token 1', created_by: 1, created_at: '2026-01-01', last_used_at: null, expires_at: null },
      { id: 2, name: 'Token 2', created_by: 2, created_at: '2026-01-02', last_used_at: null, expires_at: null },
    ];
    mockListAllApiTokens.mockResolvedValue(tokens as any);

    const response = await GET(createMockRequest());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual(tokens);
    expect(mockListAllApiTokens).toHaveBeenCalled();
    expect(mockListApiTokens).not.toHaveBeenCalled();
  });

  it('returns own tokens for non-admin user', async () => {
    mockRequireApiUser.mockResolvedValue({ userId: 5, role: 'user', authMethod: 'bearer' });
    const tokens = [{ id: 3, name: 'My Token', created_by: 5, created_at: '2026-01-01', last_used_at: null, expires_at: null }];
    mockListApiTokens.mockResolvedValue(tokens as any);

    const response = await GET(createMockRequest());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual(tokens);
    expect(mockListApiTokens).toHaveBeenCalledWith(5);
    expect(mockListAllApiTokens).not.toHaveBeenCalled();
  });

  it('returns 401 on auth failure', async () => {
    const { ApiAuthError } = await import('@/src/lib/api-auth');
    mockRequireApiUser.mockRejectedValue(new ApiAuthError('Unauthorized', 401));

    const response = await GET(createMockRequest());
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });
});

describe('POST /api/v1/tokens', () => {
  it('creates a token and returns 201', async () => {
    const tokenResult = {
      token: { id: 10, name: 'New Token', created_by: 1, created_at: '2026-01-01', last_used_at: null, expires_at: null },
      rawToken: 'cpm_raw_token_abc123',
    };
    mockCreateApiToken.mockResolvedValue(tokenResult as any);

    const response = await POST(createMockRequest({ method: 'POST', body: { name: 'New Token' } }));
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.raw_token).toBe('cpm_raw_token_abc123');
    expect(data.token).toEqual(tokenResult.token);
    expect(mockCreateApiToken).toHaveBeenCalledWith('New Token', 1, undefined);
  });

  it('creates a token with expires_at', async () => {
    const tokenResult = {
      token: { id: 11, name: 'Expiring Token', created_by: 1, created_at: '2026-01-01', last_used_at: null, expires_at: '2027-01-01' },
      rawToken: 'cpm_raw_token_xyz',
    };
    mockCreateApiToken.mockResolvedValue(tokenResult as any);

    const response = await POST(createMockRequest({ method: 'POST', body: { name: 'Expiring Token', expires_at: '2027-01-01' } }));
    await response.json();

    expect(response.status).toBe(201);
    expect(mockCreateApiToken).toHaveBeenCalledWith('Expiring Token', 1, '2027-01-01');
  });

  it('rejects token creation authenticated by another bearer token', async () => {
    mockRequireApiUser.mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' });

    const response = await POST(createMockRequest({
      method: 'POST',
      body: { name: 'Persistent replacement' },
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'API tokens can only be created from an authenticated session',
    });
    expect(mockCreateApiToken).not.toHaveBeenCalled();
  });

  it('preserves token self-service for non-admin sessions', async () => {
    mockRequireApiUser.mockResolvedValue({ userId: 5, role: 'viewer', authMethod: 'session' });
    mockCreateApiToken.mockResolvedValue({
      token: { id: 12, name: 'Viewer Token' },
      rawToken: 'viewer-token',
    } as any);

    const response = await POST(createMockRequest({ method: 'POST', body: { name: 'Viewer Token' } }));

    expect(response.status).toBe(201);
    expect(mockCreateApiToken).toHaveBeenCalledWith('Viewer Token', 5, undefined);
  });

  it('returns 400 when name is missing', async () => {
    const response = await POST(createMockRequest({ method: 'POST', body: {} }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('name is required');
  });

  it('returns 400 when name is not a string', async () => {
    const response = await POST(createMockRequest({ method: 'POST', body: { name: 123 } }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('name is required');
  });
});

describe('DELETE /api/v1/tokens/[id]', () => {
  it('deletes a token and returns ok', async () => {
    mockDeleteApiToken.mockResolvedValue(undefined as any);

    const response = await DELETE(createMockRequest({ method: 'DELETE' }), { params: Promise.resolve({ id: '5' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(mockDeleteApiToken).toHaveBeenCalledWith(5, 1, true);
  });

  it('limits non-admin deletion to the authenticated user', async () => {
    mockRequireApiUser.mockResolvedValue({ userId: 7, role: 'user', authMethod: 'session' });
    mockDeleteApiToken.mockResolvedValue(undefined as any);

    const response = await DELETE(createMockRequest({ method: 'DELETE' }), {
      params: Promise.resolve({ id: '9' }),
    });

    expect(response.status).toBe(200);
    expect(mockDeleteApiToken).toHaveBeenCalledWith(9, 7, false);
  });

  it('returns 401 on auth failure', async () => {
    const { ApiAuthError } = await import('@/src/lib/api-auth');
    mockRequireApiUser.mockRejectedValue(new ApiAuthError('Unauthorized', 401));

    const response = await DELETE(createMockRequest({ method: 'DELETE' }), { params: Promise.resolve({ id: '5' }) });
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });
});

describe('POST /api/v1/tokens with scopes and expiry presets', () => {
  it('passes scopes to the model, which checks them against the role', async () => {
    mockCreateApiToken.mockResolvedValue({ token: { id: 20, name: 'Terraform', scopes: ['proxy_hosts:write'] }, rawToken: 'raw' } as any);
    const response = await POST(createMockRequest({ method: 'POST', body: { name: 'Terraform', scopes: ['proxy_hosts:write'] } }));
    expect(response.status).toBe(201);
    expect(mockCreateApiToken).toHaveBeenCalledWith('Terraform', 1, undefined, { scopes: ['proxy_hosts:write'] });
  });

  it('turns expiresIn into a date and "never" into no expiry', async () => {
    mockCreateApiToken.mockResolvedValue({ token: { id: 21, name: 'CI' }, rawToken: 'raw' } as any);
    const before = Date.now();
    await POST(createMockRequest({ method: 'POST', body: { name: 'CI', expiresIn: '90d' } }));
    const expiresAt = new Date(mockCreateApiToken.mock.calls[0][2] as string).getTime();
    expect(expiresAt - before).toBeGreaterThanOrEqual(90 * 86_400_000 - 1000);
    expect(expiresAt - before).toBeLessThanOrEqual(90 * 86_400_000 + 5000);

    await POST(createMockRequest({ method: 'POST', body: { name: 'CI', expiresIn: 'never' } }));
    expect(mockCreateApiToken.mock.calls[1][2]).toBeUndefined();
  });

  it('refuses an unknown preset and both expiry fields at once', async () => {
    const unknown = await POST(createMockRequest({ method: 'POST', body: { name: 'CI', expiresIn: '7d' } }));
    expect(unknown.status).toBe(400);
    const both = await POST(createMockRequest({ method: 'POST', body: { name: 'CI', expiresIn: '30d', expires_at: '2030-01-01T00:00:00Z' } }));
    expect(both.status).toBe(400);
    expect(mockCreateApiToken).not.toHaveBeenCalled();
  });
});
