import { describe, expect, it, vi } from 'vitest';

vi.mock('@/src/lib/api-auth', () => ({
  requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
  requireApiAdmin: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
  apiErrorResponse: vi.fn(),
}));

import { GET } from '@/app/api/v1/openapi.json/route';

describe('OpenAPI: compliance reports and incident drafts', () => {
  it('documents every endpoint and every reference resolves', async () => {
    const spec = await (await GET({ headers: { get: () => null } } as any)).json();
    const expected: Record<string, string[]> = {
      '/api/v1/compliance/controls': ['get'],
      '/api/v1/compliance/reports': ['get', 'post'],
      '/api/v1/compliance/reports/{id}': ['get', 'delete'],
      '/api/v1/compliance/reports/{id}/export': ['get'],
      '/api/v1/compliance/incidents': ['get', 'post'],
      '/api/v1/compliance/incidents/{id}': ['get', 'put', 'delete'],
      '/api/v1/compliance/incidents/{id}/facts': ['post'],
      '/api/v1/compliance/incidents/{id}/draft': ['post'],
    };
    const operationIds = new Set<string>();
    for (const [path, methods] of Object.entries(expected)) {
      expect(Object.keys(spec.paths[path]).sort(), path).toEqual([...methods].sort());
      for (const method of methods) {
        expect(spec.paths[path][method].tags).toEqual(['Compliance']);
        operationIds.add(spec.paths[path][method].operationId);
      }
    }
    expect(operationIds.size).toBe(13);
    expect(spec.tags.map((tag: { name: string }) => tag.name)).toContain('Compliance');

    const documented = JSON.stringify(Object.fromEntries(Object.keys(expected).map((path) => [path, spec.paths[path]])));
    const schemas = Object.keys(spec.components.schemas).filter((name) => name.startsWith('Compliance'));
    expect(schemas.length).toBeGreaterThan(10);
    const refs = (documented + JSON.stringify(schemas.map((name) => spec.components.schemas[name]))).match(/"\$ref":"#\/components\/[^"]+"/g) ?? [];
    for (const ref of new Set(refs)) {
      const path = JSON.parse(`{${ref}}`).$ref.slice('#/'.length).split('/');
      expect(path.reduce((node: any, key: string) => node?.[key], spec), ref).toBeDefined();
    }
  });

  it('documents the permissions and that nothing is sent', async () => {
    const spec = await (await GET({ headers: { get: () => null } } as any)).json();
    expect(spec.paths['/api/v1/compliance/reports'].post.description).toMatch(/Permission compliance:write/);
    expect(spec.paths['/api/v1/compliance/incidents'].post.description).toMatch(/Nothing is sent anywhere/);
    expect(spec.paths['/api/v1/compliance/incidents/{id}/draft'].post.description).toMatch(/aggregated facts only, as untrusted data, and no tools/);
  });
});
