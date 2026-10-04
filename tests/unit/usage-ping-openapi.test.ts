import { describe, expect, it, vi } from 'vitest';

vi.mock('@/src/lib/api-auth', () => ({
  requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
  requireApiAdmin: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
  apiErrorResponse: vi.fn(),
}));

import { GET } from '@/app/api/v1/openapi.json/route';
import { COUNT_BUCKETS, FEATURE_FIELDS, USAGE_PING_EDITIONS } from '@/src/lib/usage-ping/payload';

async function spec() {
  return (await GET({ headers: { get: () => null } } as never)).json();
}

describe('OpenAPI: usage ping', () => {
  it('documents every endpoint and every reference resolves', async () => {
    const doc = await spec();
    const expected: Record<string, string[]> = {
      '/api/v1/usage-ping': ['get', 'put'],
      '/api/v1/usage-ping/reset-install-id': ['post'],
    };
    for (const [path, methods] of Object.entries(expected)) {
      expect(Object.keys(doc.paths[path]).sort(), path).toEqual([...methods].sort());
      for (const method of methods) {
        expect(doc.paths[path][method].tags).toEqual(['Usage Ping']);
        expect(doc.paths[path][method].description).toMatch(/settings:(read|write)/);
      }
    }
    expect(doc.tags.map((tag: { name: string }) => tag.name)).toContain('Usage Ping');

    const documented = JSON.stringify([
      ...Object.keys(expected).map((path) => doc.paths[path]),
      doc.components.schemas.UsagePing,
      doc.components.schemas.UsagePingPayload,
      doc.components.schemas.UsagePingInput,
    ]);
    const refs = documented.match(/"\$ref":"#\/components\/[^"]+"/g) ?? [];
    expect(refs.length).toBeGreaterThan(5);
    for (const ref of new Set(refs)) {
      const path = JSON.parse(`{${ref}}`).$ref.slice('#/'.length).split('/');
      expect(path.reduce((node: any, key: string) => node?.[key], doc), ref).toBeDefined();
    }
  });

  it('describes the payload from the field lists the product sends', async () => {
    const payload = (await spec()).components.schemas.UsagePingPayload;
    expect(payload.additionalProperties).toBe(false);
    expect(payload.properties.features.required).toEqual([...FEATURE_FIELDS]);
    expect(payload.properties.counts.properties.users.enum).toEqual([...COUNT_BUCKETS]);
    expect(payload.properties.edition.enum).toEqual([...USAGE_PING_EDITIONS]);
  });
});
