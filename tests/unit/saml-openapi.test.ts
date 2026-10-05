import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('@/src/lib/api-auth', () => ({
  requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
  requireApiAdmin: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
  apiErrorResponse: vi.fn(),
}));

import { GET } from '@/app/api/v1/openapi.json/route';
import { ADMIN_LEVEL_PERMISSIONS, PERMISSION_AREAS } from '@/src/lib/permissions';
import { FEATURE_INFO } from '@/ee/licensing/features';
import { NAV_PAGES } from '@/src/lib/navigation';

async function spec() {
  return (await GET({ headers: { get: () => null } } as never)).json();
}

describe('OpenAPI: SAML providers', () => {
  it('documents every endpoint and every reference resolves', async () => {
    const doc = await spec();
    const expected: Record<string, string[]> = {
      '/api/v1/saml-providers': ['get', 'post'],
      '/api/v1/saml-providers/{id}': ['get', 'put', 'delete'],
      '/api/v1/saml-providers/{id}/metadata': ['get'],
    };
    for (const [path, methods] of Object.entries(expected)) {
      expect(Object.keys(doc.paths[path]).sort(), path).toEqual([...methods].sort());
      for (const method of methods) {
        expect(doc.paths[path][method].tags).toEqual(['SAML Providers']);
        expect(doc.paths[path][method].operationId).toBeTruthy();
      }
    }
    expect(doc.tags.map((tag: { name: string }) => tag.name)).toContain('SAML Providers');
    const schemas = ['SamlProvider', 'SamlProviderInput', 'SamlProviderUpdate'];
    const documented = JSON.stringify([
      Object.fromEntries(Object.keys(expected).map((path) => [path, doc.paths[path]])),
      schemas.map((name) => doc.components.schemas[name]),
    ]);
    const refs = documented.match(/"\$ref":"#\/components\/[^"]+"/g) ?? [];
    expect(refs.length).toBeGreaterThan(8);
    for (const ref of new Set(refs)) {
      const path = JSON.parse(`{${ref}}`).$ref.slice('#/'.length).split('/');
      expect(path.reduce((node: any, key: string) => node?.[key], doc), ref).toBeDefined();
    }
    expect(doc.components.schemas.SsoEnforcement.properties.ssoProviders.items.properties.kind.enum).toEqual(['oidc', 'saml']);
  });

  it('documents the SP private key as write-only input and never as output', async () => {
    const doc = await spec();
    for (const name of ['SamlProviderInput', 'SamlProviderUpdate']) {
      expect(doc.components.schemas[name].properties.spPrivateKey.writeOnly, name).toBe(true);
      expect(doc.components.schemas[name].additionalProperties).toBe(false);
    }
    expect(JSON.stringify(doc.components.schemas.SamlProvider.properties)).not.toContain('"spPrivateKey"');
  });

  it('ships the feature with administrator-level management in the sso area', () => {
    expect(FEATURE_INFO.sso_saml).toMatchObject({ edition: 'business' });
    expect(PERMISSION_AREAS.sso.actions).toEqual(['read', 'write']);
    expect(ADMIN_LEVEL_PERMISSIONS).toContain('sso:write');
    expect(NAV_PAGES.find((page) => page.href === '/saml')?.permission).toBe('sso:read');
  });

  it('documents the feature, the former blockers and the IdP setups', () => {
    const doc = readFileSync(resolve(__dirname, '../../ee/docs/sso-saml.md'), 'utf8');
    for (const heading of ['Microsoft Entra ID', 'Okta', 'Google Workspace', 'Keycloak', 'How the former blockers are closed']) {
      expect(doc, heading).toContain(heading);
    }
    expect(readFileSync(resolve(__dirname, '../../ee/docs/README.md'), 'utf8')).toMatch(/\| SAML single sign-on \| Business \| \[sso-saml\.md\]/);
  });
});
