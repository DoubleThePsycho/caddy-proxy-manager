import { describe, expect, it, vi } from 'vitest';

vi.mock('@/src/lib/api-auth', () => ({
  requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
  requireApiAdmin: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
  apiErrorResponse: vi.fn(),
}));

import { GET } from '@/app/api/v1/openapi.json/route';
import { ADMIN_LEVEL_PERMISSIONS, PERMISSION_AREAS } from '@/src/lib/permissions';
import { FEATURE_INFO } from '@/ee/licensing/features';

async function spec() {
  return (await GET({ headers: { get: () => null } } as never)).json();
}

describe('OpenAPI: LDAP directories', () => {
  it('documents every endpoint and every reference resolves', async () => {
    const doc = await spec();
    const expected: Record<string, string[]> = {
      '/api/v1/ldap-directories': ['get', 'post'],
      '/api/v1/ldap-directories/{id}': ['get', 'put', 'delete'],
      '/api/v1/ldap-directories/{id}/test': ['post'],
      '/api/v1/ldap-directories/{id}/test-sign-in': ['post'],
    };
    for (const [path, methods] of Object.entries(expected)) {
      expect(Object.keys(doc.paths[path]).sort(), path).toEqual([...methods].sort());
      for (const method of methods) {
        expect(doc.paths[path][method].tags).toEqual(['LDAP Directories']);
        expect(doc.paths[path][method].operationId).toBeTruthy();
      }
    }
    expect(doc.tags.map((tag: { name: string }) => tag.name)).toContain('LDAP Directories');
    const schemas = ['LdapDirectory', 'LdapDirectoryInput', 'LdapDirectoryUpdate', 'LdapConnectionTestResult', 'LdapSignInTestInput', 'LdapSignInTestResult'];
    const documented = JSON.stringify([
      Object.fromEntries(Object.keys(expected).map((path) => [path, doc.paths[path]])),
      schemas.map((name) => doc.components.schemas[name]),
    ]);
    const refs = documented.match(/"\$ref":"#\/components\/[^"]+"/g) ?? [];
    expect(refs.length).toBeGreaterThan(10);
    for (const ref of new Set(refs)) {
      const path = JSON.parse(`{${ref}}`).$ref.slice('#/'.length).split('/');
      expect(path.reduce((node: any, key: string) => node?.[key], doc), ref).toBeDefined();
    }
  });

  it('documents the service account password as a write-only input and never as output', async () => {
    const doc = await spec();
    for (const name of ['LdapDirectoryInput', 'LdapDirectoryUpdate']) {
      expect(doc.components.schemas[name].properties.bindPassword.writeOnly, name).toBe(true);
    }
    expect(doc.components.schemas.LdapSignInTestInput.properties.password.writeOnly).toBe(true);
    expect(JSON.stringify(doc.components.schemas.LdapDirectory.properties)).not.toContain('"bindPassword"');
  });

  it('ships the feature with an administrator-level write permission', () => {
    expect(FEATURE_INFO.ldap).toMatchObject({ edition: 'enterprise' });
    expect(PERMISSION_AREAS.ldap).toMatchObject({ actions: ['read', 'write'], paid: true });
    expect(ADMIN_LEVEL_PERMISSIONS).toContain('ldap:write');
  });
});
