/**
 * GET /api/instances/sync?status=1 (the slave's sync status for drift
 * detection) and the record a successful sync leaves: authenticated like the
 * sync, slave mode only, no nonce issued, and recorded only after Caddy took
 * the configuration.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/src/lib/instance-sync', () => ({
  applySyncPayload: vi.fn(),
  getInstanceMode: vi.fn(),
  getSlaveMasterToken: vi.fn(),
  setSlaveLastSync: vi.fn(),
}));
vi.mock('@/src/lib/instance-sync-status', () => ({
  buildReplicaSyncStatus: vi.fn(),
  recordAppliedSync: vi.fn(),
}));

import { GET, POST } from '@/app/api/instances/sync/route';
import { applyCaddyConfig } from '@/src/lib/caddy';
import { applySyncPayload, getInstanceMode, getSlaveMasterToken } from '@/src/lib/instance-sync';
import { buildReplicaSyncStatus, recordAppliedSync } from '@/src/lib/instance-sync-status';

const TOKEN = 'status-token-0123456789abcdef0123456789abcdef';
const STATUS = {
  syncStatus: {
    version: 1,
    appVersion: '2.1.0',
    fingerprint: 'a'.repeat(64),
    appliedAt: '2026-10-02T10:00:00.000Z',
    localChanges: false,
    overriddenSettings: [],
    lastSync: { at: '2026-10-02T10:00:00.000Z', error: null },
    caddy: null,
  },
};

let client = 0;

function request(method: 'GET' | 'POST', token: string | null = TOKEN, query = '?status=1') {
  const headers: Record<string, string> = { 'x-forwarded-for': `203.0.113.${++client}` };
  if (token) headers.authorization = `Bearer ${token}`;
  if (method === 'GET') return new NextRequest(`http://localhost/api/instances/sync${query}`, { method, headers });
  headers['content-type'] = 'application/json';
  return new NextRequest('http://localhost/api/instances/sync', {
    method,
    headers,
    body: JSON.stringify({
      generated_at: new Date().toISOString(),
      settings: {},
      data: { certificates: [], caCertificates: [], issuedClientCertificates: [], accessLists: [], accessListEntries: [], proxyHosts: [], l4ProxyHosts: [] },
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getInstanceMode).mockResolvedValue('slave');
  vi.mocked(getSlaveMasterToken).mockResolvedValue(TOKEN);
  vi.mocked(buildReplicaSyncStatus).mockResolvedValue(STATUS as never);
  vi.mocked(applySyncPayload).mockResolvedValue({ fingerprint: 'b'.repeat(64) });
});

describe('GET /api/instances/sync?status=1', () => {
  it('returns the status without issuing a nonce, not to be cached', async () => {
    const response = await GET(request('GET'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toEqual(STATUS);
    expect(body).not.toHaveProperty('nonce');
  });

  it.each([
    ['no token', null],
    ['a wrong token', 'wrong-token-0123456789abcdef0123456789abcd'],
  ])('refuses a request with %s and builds no status', async (_case, token) => {
    const response = await GET(request('GET', token));
    expect(response.status).toBe(401);
    expect(buildReplicaSyncStatus).not.toHaveBeenCalled();
  });

  it.each(['master', 'standalone'] as const)('answers 403 on a %s instance', async (mode) => {
    vi.mocked(getInstanceMode).mockResolvedValue(mode);
    expect((await GET(request('GET'))).status).toBe(403);
    expect(buildReplicaSyncStatus).not.toHaveBeenCalled();
  });

  it('answers the key request as before without the parameter', async () => {
    const body = await (await GET(request('GET', TOKEN, ''))).json();
    expect(body).toHaveProperty('nonce');
    expect(body).not.toHaveProperty('syncStatus');
  });
});

describe('POST /api/instances/sync records the applied sync', () => {
  it('after Caddy took the configuration', async () => {
    const response = await POST(request('POST'));
    expect(response.status).toBe(200);
    expect(recordAppliedSync).toHaveBeenCalledWith({ fingerprint: 'b'.repeat(64) });
  });

  it('not when Caddy rejected it', async () => {
    vi.mocked(applyCaddyConfig).mockRejectedValueOnce(new Error('rejected'));
    const response = await POST(request('POST'));
    expect(response.status).toBe(500);
    expect(recordAppliedSync).not.toHaveBeenCalled();
  });
});
