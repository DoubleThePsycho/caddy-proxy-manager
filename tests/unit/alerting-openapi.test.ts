import { describe, expect, it, vi } from 'vitest';

vi.mock('@/src/lib/api-auth', () => ({
  requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
  requireApiAdmin: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
  apiErrorResponse: vi.fn(),
}));

import { GET } from '@/app/api/v1/openapi.json/route';

describe('OpenAPI: alerting and AI analyst', () => {
  it('documents every endpoint and every reference resolves', async () => {
    const spec = await (await GET({ headers: { get: () => null } } as any)).json();
    const expected: Record<string, string[]> = {
      '/api/v1/alert-channels': ['get', 'post'],
      '/api/v1/alert-channels/{id}': ['get', 'put', 'delete'],
      '/api/v1/alert-channels/{id}/test': ['post'],
      '/api/v1/alert-rules': ['get', 'post'],
      '/api/v1/alert-rules/{id}': ['get', 'put', 'delete'],
      '/api/v1/alert-events': ['get'],
      '/api/v1/ai/settings': ['get', 'put', 'delete'],
      '/api/v1/ai/test': ['post'],
    };
    for (const [path, methods] of Object.entries(expected)) {
      expect(Object.keys(spec.paths[path]).sort(), path).toEqual([...methods].sort());
      for (const method of methods) {
        expect(spec.paths[path][method].tags[0]).toMatch(/^(Alerting|AI)$/);
        expect(spec.paths[path][method].operationId).toBeTruthy();
      }
    }
    expect(spec.tags.map((tag: { name: string }) => tag.name)).toEqual(expect.arrayContaining(['Alerting', 'AI']));

    const documented = JSON.stringify(Object.fromEntries(Object.keys(expected).map((path) => [path, spec.paths[path]])));
    const schemas = ['AlertChannel', 'AlertChannelInput', 'AlertChannelUpdate', 'AlertChannelConfigInput', 'AlertDeliveryResult', 'AlertRule', 'AlertRuleInput', 'AlertRuleUpdate', 'AlertRuleParams', 'AlertEvent', 'AlertEventsResponse', 'AiSettings', 'AiSettingsInput', 'AiTestResult'];
    const refs = (documented + JSON.stringify(schemas.map((name) => spec.components.schemas[name]))).match(/"\$ref":"#\/components\/[^"]+"/g) ?? [];
    expect(refs.length).toBeGreaterThan(10);
    for (const ref of new Set(refs)) {
      const path = JSON.parse(`{${ref}}`).$ref.slice('#/'.length).split('/');
      expect(path.reduce((node: any, key: string) => node?.[key], spec), ref).toBeDefined();
    }
  });

  it('documents credentials as write-only and never as output', async () => {
    const spec = await (await GET({ headers: { get: () => null } } as any)).json();
    const input = spec.components.schemas.AlertChannelConfigInput.properties;
    for (const field of ['password', 'webhookUrl', 'url', 'hmacSecret', 'routingKey', 'token']) {
      expect(input[field].writeOnly, field).toBe(true);
    }
    expect(spec.components.schemas.AiSettingsInput.properties.apiKey.writeOnly).toBe(true);
    const output = JSON.stringify([spec.components.schemas.AlertChannel, spec.components.schemas.AiSettings]);
    for (const field of ['"password"', '"webhookUrl"', '"routingKey"', '"apiKey"', '"hmacSecret"']) {
      expect(output).not.toContain(field);
    }
  });
});
