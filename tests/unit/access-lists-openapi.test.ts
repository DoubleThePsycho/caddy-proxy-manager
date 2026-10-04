import { describe, expect, it, vi } from 'vitest';

vi.mock('@/src/lib/api-auth', () => ({
  requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
  requireApiAdmin: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
  apiErrorResponse: vi.fn(),
}));

import { GET } from '@/app/api/v1/openapi.json/route';
import { ACCESS_LIST_RULE_KINDS } from '@/src/lib/access-list-rules';

async function spec() {
  return (await GET({ headers: { get: () => null } } as never)).json();
}

describe('OpenAPI: access lists', () => {
  it('documents every endpoint with its permission, and every reference resolves', async () => {
    const doc = await spec();
    const expected: Record<string, string[]> = {
      '/api/v1/access-lists': ['get', 'post'],
      '/api/v1/access-lists/{id}': ['get', 'put', 'delete'],
      '/api/v1/access-lists/{id}/entries': ['post'],
      '/api/v1/access-lists/{id}/entries/{entryId}': ['delete'],
      '/api/v1/access-lists/{id}/rules': ['get', 'post', 'put'],
      '/api/v1/access-lists/{id}/rules/{ruleId}': ['get', 'put', 'delete'],
      '/api/v1/access-lists/{id}/rules/reorder': ['post'],
      '/api/v1/access-lists/blocked-sources': ['get', 'put'],
      '/api/v1/access-lists/blocked-sources/entries': ['get', 'post'],
      '/api/v1/access-lists/blocked-sources/entries/{entryId}': ['delete'],
      '/api/v1/access-lists/stats': ['get'],
    };
    for (const [path, methods] of Object.entries(expected)) {
      expect(Object.keys(doc.paths[path] ?? {}).sort(), path).toEqual([...methods].sort());
      for (const method of methods) {
        expect(doc.paths[path][method].tags).toEqual(['Access Lists']);
        expect(new Set(Object.values(doc.paths).flatMap((item: any) => Object.values(item).map((op: any) => op.operationId))).has(doc.paths[path][method].operationId)).toBe(true);
      }
    }
    for (const path of Object.keys(expected).filter((path) => path !== '/api/v1/access-lists/{id}/entries' && path !== '/api/v1/access-lists/{id}/entries/{entryId}')) {
      for (const operation of Object.values(doc.paths[path]) as Array<{ description?: string }>) {
        expect(operation.description, path).toMatch(/access_lists:(read|write)/);
      }
    }
    expect(doc.components.schemas.AccessListRuleInput.properties.kind.enum).toEqual([...ACCESS_LIST_RULE_KINDS]);
    expect(doc.components.schemas.AccessListEntryInput.properties.password.writeOnly).toBe(true);

    const documented = JSON.stringify([
      ...Object.keys(expected).map((path) => doc.paths[path]),
      ...['AccessList', 'AccessListInput', 'AccessListUpdate', 'AccessListRule', 'AccessListRuleInput', 'BlockedSourceInput', 'AccessListStats']
        .map((name) => doc.components.schemas[name]),
    ]);
    const refs = documented.match(/"\$ref":"#\/components\/[^"]+"/g) ?? [];
    expect(refs.length).toBeGreaterThan(10);
    for (const ref of new Set(refs)) {
      const path = JSON.parse(`{${ref}}`).$ref.slice('#/'.length).split('/');
      expect(path.reduce((node: any, key: string) => node?.[key], doc), ref).toBeDefined();
    }
  });
});
