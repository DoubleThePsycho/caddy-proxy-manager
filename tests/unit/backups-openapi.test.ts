import { describe, expect, it, vi } from 'vitest';

vi.mock('@/src/lib/api-auth', () => ({
  requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
  requireApiAdmin: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
  apiErrorResponse: vi.fn(),
}));

import { GET } from '@/app/api/v1/openapi.json/route';
import { RULE_TYPES } from '@/ee/alerting/types';

async function spec() {
  return (await GET({ headers: { get: () => null } } as never)).json();
}

describe('OpenAPI: scheduled backups', () => {
  it('documents every endpoint and every reference resolves', async () => {
    const doc = await spec();
    const expected: Record<string, string[]> = {
      '/api/v1/backup-destinations': ['get', 'post'],
      '/api/v1/backup-destinations/{id}': ['get', 'put', 'delete'],
      '/api/v1/backup-destinations/{id}/test': ['post'],
      '/api/v1/backup-destinations/{id}/run': ['post'],
      '/api/v1/backup-destinations/{id}/objects': ['get'],
      '/api/v1/backup-destinations/{id}/restore': ['post'],
      '/api/v1/backup-runs': ['get'],
    };
    for (const [path, methods] of Object.entries(expected)) {
      expect(Object.keys(doc.paths[path]).sort(), path).toEqual([...methods].sort());
      for (const method of methods) {
        expect(doc.paths[path][method].tags).toEqual(['Backups']);
        expect(doc.paths[path][method].operationId).toBeTruthy();
      }
    }
    expect(doc.tags.map((tag: { name: string }) => tag.name)).toContain('Backups');

    const schemas = ['BackupSchedule', 'BackupDestination', 'BackupDestinationInput', 'BackupDestinationUpdate', 'BackupRun', 'BackupRunsResponse', 'BackupTestResult', 'BackupObjectsListing', 'BackupRestoreInput', 'BackupRestoreResult'];
    const documented = JSON.stringify([
      Object.fromEntries(Object.keys(expected).map((path) => [path, doc.paths[path]])),
      schemas.map((name) => doc.components.schemas[name]),
    ]);
    const refs = documented.match(/"\$ref":"#\/components\/[^"]+"/g) ?? [];
    expect(refs.length).toBeGreaterThan(20);
    for (const ref of new Set(refs)) {
      const path = JSON.parse(`{${ref}}`).$ref.slice('#/'.length).split('/');
      expect(path.reduce((node: any, key: string) => node?.[key], doc), ref).toBeDefined();
    }
  });

  it('documents secrets as write-only inputs and never as output', async () => {
    const doc = await spec();
    for (const name of ['BackupDestinationInput', 'BackupDestinationUpdate']) {
      expect(doc.components.schemas[name].properties.secretAccessKey.writeOnly, name).toBe(true);
      expect(doc.components.schemas[name].properties.passphrase.writeOnly, name).toBe(true);
    }
    expect(doc.components.schemas.BackupRestoreInput.properties.passphrase.writeOnly).toBe(true);
    const output = JSON.stringify(doc.components.schemas.BackupDestination.properties);
    expect(output).not.toContain('"secretAccessKey"');
    expect(output).not.toContain('"passphrase"');
  });

  it('lists every alert rule type', async () => {
    const doc = await spec();
    expect(doc.components.schemas.AlertRuleInput.properties.type.enum).toEqual([...RULE_TYPES]);
    expect(doc.components.schemas.AlertRule.properties.type.enum).toEqual([...RULE_TYPES]);
    expect(doc.components.schemas.AlertRuleParams.properties.minFailures).toMatchObject({ minimum: 1, maximum: 100 });
  });
});
