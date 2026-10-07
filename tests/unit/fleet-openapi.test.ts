import { describe, expect, it, vi } from 'vitest';

vi.mock('@/src/lib/api-auth', () => ({
  requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
  requireApiAdmin: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
  apiErrorResponse: vi.fn(),
}));

import { GET } from '@/app/api/v1/openapi.json/route';

async function spec() {
  return (await GET({ headers: { get: () => null } } as never)).json();
}

describe('OpenAPI: fleet management', () => {
  it('documents every endpoint and every reference resolves', async () => {
    const doc = await spec();
    const expected: Record<string, string[]> = {
      '/api/v1/fleet': ['get'],
      '/api/v1/fleet/environments': ['get', 'post'],
      '/api/v1/fleet/environments/{id}': ['get', 'patch', 'delete'],
      '/api/v1/fleet/instances': ['get'],
      '/api/v1/fleet/instances/{id}/environment': ['put'],
      '/api/v1/fleet/instances/{id}/resync': ['post'],
      '/api/v1/fleet/drift': ['get', 'post'],
      '/api/v1/fleet/revisions': ['get'],
      '/api/v1/fleet/revisions/{id}': ['get'],
      '/api/v1/fleet/revisions/{id}/diff': ['get'],
      '/api/v1/fleet/promotions/preview': ['get'],
      '/api/v1/fleet/rollouts': ['get', 'post'],
      '/api/v1/fleet/rollouts/{id}': ['get'],
      '/api/v1/fleet/rollouts/{id}/abort': ['post'],
      '/api/v1/fleet/rollouts/{id}/rollback': ['post'],
      '/api/v1/fleet/pull-replicas': ['get', 'post'],
      '/api/v1/fleet/pull-replicas/{id}': ['get', 'delete'],
      '/api/v1/fleet/pull-replicas/{id}/credential': ['post', 'delete'],
    };
    const operationIds = new Set<string>();
    for (const [path, methods] of Object.entries(expected)) {
      expect(Object.keys(doc.paths[path]).sort(), path).toEqual([...methods].sort());
      for (const method of methods) {
        expect(doc.paths[path][method].tags).toEqual(['Fleet']);
        operationIds.add(doc.paths[path][method].operationId);
      }
    }
    expect(operationIds.size).toBe(Object.values(expected).flat().length);
    expect(doc.tags.map((tag: { name: string }) => tag.name)).toContain('Fleet');

    const documented = JSON.stringify(Object.fromEntries(Object.keys(expected).map((path) => [path, doc.paths[path]])));
    const schemas = Object.keys(doc.components.schemas).filter((name) => name.startsWith('Fleet'));
    const refs = (documented + JSON.stringify(schemas.map((name) => doc.components.schemas[name]))).match(/"\$ref":"#\/components\/[^"]+"/g) ?? [];
    expect(refs.length).toBeGreaterThan(20);
    for (const ref of new Set(refs)) {
      const path = JSON.parse(`{${ref}}`).$ref.slice('#/'.length).split('/');
      expect(path.reduce((node: any, key: string) => node?.[key], doc), ref).toBeDefined();
    }
  });

  it('documents pull replicas: the credential once and the permission', async () => {
    const doc = await spec();
    expect(doc.paths['/api/v1/fleet/pull-replicas'].post.description).toMatch(/fleet:replicas \(administrator-level\)/);
    expect(doc.paths['/api/v1/fleet/pull-replicas/{id}/credential'].delete.description).toMatch(/^Permission fleet:replicas\./);
    expect(doc.components.schemas.FleetPullCredential.required).toEqual(['replica', 'credential', 'env']);
    expect(Object.keys(doc.components.schemas.FleetPullReplica.properties)).not.toContain('credential');
    expect(doc.components.schemas.FleetInstance.required).toEqual(expect.arrayContaining(['syncMode', 'pull']));
  });

  it('lists the fleet alert rule types', async () => {
    const doc = await spec();
    expect(doc.components.schemas.AlertRule.properties.type.enum).toEqual(expect.arrayContaining(['fleet_drift', 'fleet_rollout_failed']));
  });

  it('says that plain syncs leave promotion-only instances out', async () => {
    const doc = await spec();
    expect(doc.paths['/api/v1/instances/sync'].post.description).toMatch(/promotion-only/);
  });
});
