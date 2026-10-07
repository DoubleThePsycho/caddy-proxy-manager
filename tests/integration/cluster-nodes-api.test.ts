/**
 * GET /api/v1/cluster/nodes (the PostgreSQL replicas): guarded by
 * high_availability:read, the replicas with their status and the leader, `enabled: false` on SQLite, nothing secret,
 * and its OpenAPI entry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDb, type TestDb } from '../helpers/db';
import { ApiClientError } from '@/src/lib/api-errors';
import * as schema from '../../src/lib/db/schema';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));
const auth = vi.hoisted(() => ({ deny: false, permissions: [] as string[] }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('@/src/lib/api-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/api-auth')>()),
  requireApiPermission: vi.fn(async (_request: unknown, permission: string) => {
    auth.permissions.push(permission);
    if (auth.deny) throw new ApiClientError('Forbidden', 403);
    return { userId: 1, role: 'admin', authMethod: 'bearer' };
  }),
}));

import { GET } from '@/app/api/v1/cluster/nodes/route';
import { GET as getOpenApi } from '@/app/api/v1/openapi.json/route';
import { HIGH_AVAILABILITY_OPENAPI_PATHS, HIGH_AVAILABILITY_OPENAPI_SCHEMAS } from '@/ee/high-availability/openapi';
import { ReplicaMembership } from '@/src/lib/cluster-nodes';

const SECRET = 'db-password-sentinel-9';

async function get() {
  const response = await GET(new NextRequest('http://localhost/api/v1/cluster/nodes'));
  const text = await response.text();
  return { status: response.status, text, data: JSON.parse(text), cache: response.headers.get('cache-control') };
}

function usePostgres() {
  // Queries go to the test database (mocked module); only the dialect switch is PostgreSQL here.
  vi.stubEnv('DATABASE_DIALECT', 'postgres');
  vi.stubEnv('DATABASE_URL', `postgres://ingressi:${SECRET}@db.example.com:5432/ingressi`);
}

beforeEach(async () => {
  ctx.db = createTestDb();
  await ctx.db.$count(schema.settings);
  auth.deny = false;
  auth.permissions = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('GET /api/v1/cluster/nodes', () => {
  it('needs high_availability:read', async () => {
    auth.deny = true;
    expect((await get()).status).toBe(403);
    expect(auth.permissions).toEqual(['high_availability:read']);
  });

  it('says so on SQLite', async () => {
    vi.stubEnv('DATABASE_DIALECT', 'sqlite');
    vi.stubEnv('DATABASE_URL', ':memory:');
    const { status, data, cache } = await get();
    expect(status).toBe(200);
    expect(cache).toBe('no-store');
    expect(data).toMatchObject({ enabled: false, nodes: [], leaderNodeId: null });
    expect(data).not.toHaveProperty('configurable');
  });

  it('lists the replicas, the leader and this replica, without secrets', async () => {
    usePostgres();
    const now = new Date();
    const stale = new Date(now.getTime() - 10 * 60_000).toISOString();
    await ctx.db.insert(schema.clusterNodes).values({
      nodeId: 'web-2',
      hostname: 'web-2.example.com',
      version: '1.2.3',
      schemaVersion: '0053_cluster_nodes',
      firstSeenAt: stale,
      startedAt: stale,
      lastHeartbeatAt: stale,
    });
    const membership = new ReplicaMembership(
      {
        nodeId: 'web-1',
        source: 'env',
        hostname: 'web-1.example.com',
        version: '1.2.3',
        schemaVersion: '0053_cluster_nodes',
        startedAt: now.toISOString(),
        instanceToken: 'instance-token-web-1',
      },
      { isLeader: () => true }
    );
    expect(await membership.join()).toBe('admitted');
    await membership.leadershipChanged(true);

    const { status, text, data } = await get();
    expect(status).toBe(200);
    expect(data).toMatchObject({
      enabled: true,
      nodeId: 'web-1',
      leaderNodeId: 'web-1',
      liveReplicas: 1,
      refusal: null,
      heartbeatSeconds: 10,
      goneAfterSeconds: 45,
      pruneAfterDays: 30,
      election: { state: 'off', leader: false, lastError: null },
    });
    expect(data.nodes).toEqual([
      expect.objectContaining({ id: 'web-2', status: 'gone', leader: false, thisNode: false, hostname: 'web-2.example.com' }),
      expect.objectContaining({ id: 'web-1', status: 'live', leader: true, thisNode: true, version: '1.2.3' }),
    ]);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('db.example.com');
    // Which process wrote a row is never shown.
    expect(text).not.toContain('instance-token-web-1');
    await membership.stop();
  });

  it('is in the OpenAPI document', async () => {
    const entry = (HIGH_AVAILABILITY_OPENAPI_PATHS as Record<string, { get?: { operationId?: string; description?: string } }>)[
      '/api/v1/cluster/nodes'
    ];
    expect(entry?.get?.operationId).toBe('listClusterNodes');
    expect(entry?.get?.description).toContain('high_availability:read');
    expect(HIGH_AVAILABILITY_OPENAPI_SCHEMAS).toHaveProperty('ClusterNodes');
    const document = await (await getOpenApi(new NextRequest('http://localhost/api/v1/openapi.json'))).json();
    expect(document.paths['/api/v1/cluster/nodes'].get.operationId).toBe('listClusterNodes');
    expect(document.components.schemas.ClusterNodes.properties.nodes.items.properties.status.enum).toEqual(['live', 'stopped', 'gone']);
  });
});
