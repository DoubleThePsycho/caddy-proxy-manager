/**
 * GET /api/v1/high-availability/cluster: guarded by high_availability:read,
 * the supervisor's status and the configuration without a single secret, and a clear error when the status is missing or
 * stale. Plus its OpenAPI entry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { ApiClientError } from '@/src/lib/api-errors';

const auth = vi.hoisted(() => ({ deny: false, permissions: [] as string[] }));

vi.mock('@/src/lib/api-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/api-auth')>()),
  requireApiPermission: vi.fn(async (_request: unknown, permission: string) => {
    auth.permissions.push(permission);
    if (auth.deny) throw new ApiClientError('Forbidden', 403);
    return { userId: 1, role: 'admin', authMethod: 'bearer' };
  }),
}));

import { GET } from '@/app/api/v1/high-availability/cluster/route';
import { HIGH_AVAILABILITY_OPENAPI_PATHS, HIGH_AVAILABILITY_OPENAPI_SCHEMAS } from '@/ee/high-availability/openapi';
import type { NodeStatusFile } from '@/ee/high-availability/cluster/types';

const SECRETS = ['redis-password-sentinel-7', 's3-secret-sentinel-8'];
const ENV = {
  HA_ENABLED: 'true',
  HA_NODE_ID: 'web-1',
  HA_REDIS_ADDRESSES: 'valkey.example.com:6379',
  HA_REDIS_PASSWORD: SECRETS[0],
  HA_S3_ENDPOINT: 'https://s3.example.com',
  HA_S3_BUCKET: 'ingressi-ha',
  HA_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  HA_S3_SECRET_ACCESS_KEY: SECRETS[1],
  DATABASE_PATH: '/app/data/ingressi.db',
};

let dir: string;

function status(overrides: Partial<NodeStatusFile> = {}): NodeStatusFile {
  const now = new Date().toISOString();
  return {
    version: 1,
    nodeId: 'web-1',
    role: 'leader',
    startedAt: now,
    updatedAt: now,
    fenceAt: new Date(Date.now() + 13_000).toISOString(),
    lease: { holder: 'web-1', epoch: 7, checkedAt: now, error: null },
    replication: { replicaId: 'e7-0a1b2c3d', lastSyncAt: now, lagSeconds: 1, error: null, checkedAt: now },
    follow: null,
    lastRestore: { at: now, ok: true, source: 'replica', replicaId: 'e6-99887766', durationMs: 2_400, error: null },
    nodes: [{ id: 'web-2', role: 'standby', epoch: null, follow: { replicaId: 'e7-0a1b2c3d', ready: true, error: null }, lastRestore: null, updatedAt: now }],
    ...overrides,
  };
}

function useStatus(value: NodeStatusFile) {
  const path = join(dir, 'status.json');
  writeFileSync(path, JSON.stringify(value));
  vi.stubEnv('HA_STATUS_FILE', path);
}

async function get() {
  const response = await GET(new NextRequest('http://localhost/api/v1/high-availability/cluster'));
  const text = await response.text();
  return { status: response.status, text, data: JSON.parse(text) };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ha-api-'));
  auth.deny = false;
  auth.permissions = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/v1/high-availability/cluster', () => {
  it('needs high_availability:read', async () => {
    auth.deny = true;
    const { status } = await get();
    expect(status).toBe(403);
    expect(auth.permissions).toEqual(['high_availability:read']);
  });

  it('says high availability is off when HA_ENABLED is not set', async () => {
    const { status, data } = await get();
    expect(status).toBe(200);
    expect(data).toMatchObject({ enabled: false, node: null, nodes: [], config: null });
    expect(data).not.toHaveProperty('configurable');
  });

  it('shows the cluster without any secret', async () => {
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
    useStatus(status());
    const { status: code, text, data } = await get();
    expect(code).toBe(200);
    expect(data).toMatchObject({
      enabled: true,
      error: null,
      node: { id: 'web-1', role: 'leader' },
      lease: { holder: 'web-1', epoch: 7, ttlSeconds: 15 },
      replication: { replicaId: 'e7-0a1b2c3d', lagSeconds: 1 },
      lastRestore: { ok: true, source: 'replica', replicaId: 'e6-99887766' },
      nodes: [{ id: 'web-2', role: 'standby' }],
      config: {
        redis: { mode: 'standalone', addresses: ['valkey.example.com:6379'], hasPassword: true },
        storage: { endpoint: 'https://s3.example.com', bucket: 'ingressi-ha', path: 'ingressi' },
      },
    });
    for (const secret of [...SECRETS, 'AKIAEXAMPLE']) expect(text).not.toContain(secret);
  });

  it('reports a missing or stale supervisor status', async () => {
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
    expect((await get()).data.error).toMatch(/supervisor's status cannot be read/);
    useStatus(status({ updatedAt: new Date(Date.now() - 5 * 60_000).toISOString() }));
    expect((await get()).data.error).toMatch(/has not updated its status since/);
  });

  it('reports a configuration error without failing', async () => {
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
    vi.stubEnv('HA_S3_BUCKET', '');
    useStatus(status());
    const { status: code, data } = await get();
    expect(code).toBe(200);
    expect(data.error).toBe('HA_S3_BUCKET is required when HA_ENABLED is set');
    expect(data.config).toBeNull();
  });
});

describe('OpenAPI', () => {
  it('documents the endpoint and its schema', () => {
    const operation = (HIGH_AVAILABILITY_OPENAPI_PATHS as Record<string, Record<string, { operationId: string; description: string }>>)[
      '/api/v1/high-availability/cluster'
    ].get;
    expect(operation.operationId).toBe('getHighAvailabilityCluster');
    expect(operation.description).toContain('high_availability:read');
    expect(Object.keys(HIGH_AVAILABILITY_OPENAPI_SCHEMAS)).toContain('HighAvailabilityCluster');
  });
});
