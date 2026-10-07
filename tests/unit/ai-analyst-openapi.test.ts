import { describe, expect, it, vi } from 'vitest';

vi.mock('@/src/lib/api-auth', () => ({
  requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
  requireApiAdmin: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
  apiErrorResponse: vi.fn(),
}));

import { GET } from '@/app/api/v1/openapi.json/route';

describe('OpenAPI: AI analyst digest and WAF tuning suggestions', () => {
  it('documents every endpoint and every reference resolves', async () => {
    const spec = await (await GET({ headers: { get: () => null } } as any)).json();
    const expected: Record<string, string[]> = {
      '/api/v1/ai/digest': ['get', 'put'],
      '/api/v1/ai/digest/preview': ['post'],
      '/api/v1/ai/digest/send': ['post'],
      '/api/v1/waf/tuning-suggestions': ['get'],
      '/api/v1/waf/tuning-suggestions/{id}/apply': ['post'],
      '/api/v1/waf/tuning-suggestions/{id}/dismiss': ['post'],
    };
    const operationIds = new Set<string>();
    for (const [path, methods] of Object.entries(expected)) {
      expect(Object.keys(spec.paths[path]).sort(), path).toEqual([...methods].sort());
      for (const method of methods) {
        expect(spec.paths[path][method].tags).toEqual(['AI']);
        operationIds.add(spec.paths[path][method].operationId);
      }
    }
    expect(operationIds.size).toBe(7);

    const schemas = ['AiDigestSettings', 'AiDigestSettingsInput', 'AiDigestPreview', 'AiDigestSendResult', 'AiDigestDelivery', 'AiDigestNarrative', 'WafTuningSuggestion', 'WafTuningResult', 'WafTuningApplyResult'];
    const documented = JSON.stringify(Object.fromEntries(Object.keys(expected).map((path) => [path, spec.paths[path]])));
    const refs = (documented + JSON.stringify(schemas.map((name) => spec.components.schemas[name]))).match(/"\$ref":"#\/components\/[^"]+"/g) ?? [];
    expect(refs.length).toBeGreaterThan(10);
    for (const ref of new Set(refs)) {
      const path = JSON.parse(`{${ref}}`).$ref.slice('#/'.length).split('/');
      expect(path.reduce((node: any, key: string) => node?.[key], spec), ref).toBeDefined();
    }
  });

  it('documents that nothing is applied automatically', async () => {
    const spec = await (await GET({ headers: { get: () => null } } as any)).json();
    expect(spec.paths['/api/v1/waf/tuning-suggestions'].get.description).toMatch(/Nothing is applied automatically/);
    expect(spec.paths['/api/v1/waf/tuning-suggestions/{id}/apply'].post.description).toMatch(/Suppress for host/);
  });
});
