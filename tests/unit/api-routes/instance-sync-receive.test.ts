import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/src/lib/caddy', () => ({
  applyCaddyConfig: vi.fn(),
}));

vi.mock('@/src/lib/instance-sync', () => ({
  applySyncPayload: vi.fn(),
  getInstanceMode: vi.fn().mockResolvedValue('slave'),
  getSlaveMasterToken: vi.fn().mockResolvedValue('sync-token'),
  setSlaveLastSync: vi.fn(),
}));

import { POST } from '@/app/api/instances/sync/route';
import { applyCaddyConfig } from '@/src/lib/caddy';
import { applySyncPayload, setSlaveLastSync } from '@/src/lib/instance-sync';

const mockApplySyncPayload = vi.mocked(applySyncPayload);
const mockApplyCaddyConfig = vi.mocked(applyCaddyConfig);
const mockSetSlaveLastSync = vi.mocked(setSlaveLastSync);

beforeEach(() => {
  vi.clearAllMocks();
  mockApplySyncPayload.mockResolvedValue(undefined);
  mockApplyCaddyConfig.mockResolvedValue(undefined);
  mockSetSlaveLastSync.mockResolvedValue(undefined);
});

function makePayload() {
  const now = new Date().toISOString();
  return {
    generated_at: now,
    settings: {},
    data: {
      certificates: [],
      caCertificates: [],
      issuedClientCertificates: [],
      accessLists: [],
      accessListEntries: [],
      proxyHosts: [
        {
          id: 1,
          name: 'Synced Host',
          domains: JSON.stringify(['synced.example.com']),
          upstreams: JSON.stringify(['backend:8080']),
          certificateId: null,
          accessListId: null,
          ownerUserId: null,
          sslForced: false,
          hstsEnabled: false,
          hstsSubdomains: false,
          allowWebsocket: false,
          preserveHostHeader: false,
          meta: null,
          enabled: true,
          createdAt: now,
          updatedAt: now,
          skipHttpsHostnameValidation: false,
        },
      ],
      l4ProxyHosts: [] as unknown[],
    },
  };
}

describe('POST /api/instances/sync', () => {
  it('accepts proxy hosts using the current proxy_hosts schema', async () => {
    const request = new NextRequest('http://localhost/api/instances/sync', {
      method: 'POST',
      headers: {
        authorization: 'Bearer sync-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(makePayload()),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mockApplySyncPayload).toHaveBeenCalledOnce();
  });

  it('rejects malformed Unicode bearer input without throwing a 500', async () => {
    const request = new NextRequest('http://localhost/api/instances/sync', {
      method: 'POST',
      headers: {
        // Latin-1 is permitted by the Headers API but expands to two bytes per
        // character in UTF-8; the previous comparator threw on this mismatch.
        authorization: `Bearer ${'é'.repeat(16)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(makePayload()),
    });

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(mockApplySyncPayload).not.toHaveBeenCalled();
  });

  it('persists only a fixed error when Caddy apply exposes sensitive detail', async () => {
    const sensitiveDetail = 'http://caddy:2019 secret response sentinel';
    mockApplyCaddyConfig.mockRejectedValueOnce(new Error(sensitiveDetail));
    const request = new NextRequest('http://localhost/api/instances/sync', {
      method: 'POST',
      headers: {
        authorization: 'Bearer sync-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(makePayload()),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(JSON.stringify(data)).not.toContain(sensitiveDetail);
    expect(mockSetSlaveLastSync).toHaveBeenCalledWith({
      ok: false,
      error: 'Failed to apply synchronized configuration',
    });
    expect(JSON.stringify(mockSetSlaveLastSync.mock.calls)).not.toContain(sensitiveDetail);
  });

  /**
   * Regression (#295): an L4 host on a port Ingressi's own Caddy listeners bind
   * (80/443/2019) must not be applied on the replica — two listeners on the
   * same port silently split connections via SO_REUSEPORT.
   */
  it('rejects synced L4 hosts listening on reserved port 443', async () => {
    const payload = makePayload();
    payload.data.l4ProxyHosts = [
      {
        id: 1,
        name: 'SNI Passthrough',
        protocol: 'tcp',
        listenAddress: ':443',
        upstreams: JSON.stringify(['mail.internal:993']),
        matcherType: 'tls_sni',
        matcherValue: JSON.stringify(['mail.example.com']),
        tlsTermination: false,
        proxyProtocolVersion: null,
        proxyProtocolReceive: false,
        ownerUserId: null,
        meta: null,
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    const request = new NextRequest('http://localhost/api/instances/sync', {
      method: 'POST',
      headers: {
        authorization: 'Bearer sync-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "L4 proxy host 1: listen port 443 is reserved for Ingressi's own Caddy listeners (HTTP 80/443, admin API 2019)",
    });
    expect(mockApplySyncPayload).not.toHaveBeenCalled();
  });

  it('accepts synced L4 hosts on non-reserved ports', async () => {
    const payload = makePayload();
    payload.data.l4ProxyHosts = [
      {
        id: 2,
        name: 'Postgres',
        protocol: 'tcp',
        listenAddress: ':5432',
        upstreams: JSON.stringify(['db.internal:5432']),
        matcherType: 'none',
        matcherValue: null,
        tlsTermination: false,
        proxyProtocolVersion: null,
        proxyProtocolReceive: false,
        ownerUserId: null,
        meta: null,
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    const request = new NextRequest('http://localhost/api/instances/sync', {
      method: 'POST',
      headers: {
        authorization: 'Bearer sync-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mockApplySyncPayload).toHaveBeenCalledOnce();
  });
});
