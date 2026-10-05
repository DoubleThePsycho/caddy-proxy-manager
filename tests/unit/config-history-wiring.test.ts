/**
 * Wiring of configuration history and export/import into shared code:
 * the apply hook, the settings groups the configuration covers, the feature
 * flag, the migration and the API documentation.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { CONFIG_SETTING_KEYS } from '@/src/lib/config-content';
import { FEATURE_INFO } from '@/ee/licensing/features';

vi.mock('@/src/lib/api-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/api-auth')>()),
  requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
  requireApiAdmin: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
}));

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), 'utf8');

describe('applyCaddyConfig', () => {
  it('records a history snapshot after Caddy accepted the configuration and before syncing slaves', () => {
    const caddy = source('src/lib/caddy.ts');
    // The apply (applyHoldingLock, then applyCaddyConfig, which syncs).
    const body = caddy.slice(caddy.indexOf('async function applyHoldingLock('));
    const load = body.indexOf('`${config.caddyApiUrl}/load`');
    const rejected = body.indexOf('"CADDY_REJECTED"');
    const record = body.indexOf('await recordConfigSnapshotAfterApply();');
    const sync = body.indexOf('await syncInstances();');
    expect(load).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(load);
    expect(record).toBeGreaterThan(rejected);
    expect(record).toBeGreaterThan(load);
    expect(sync).toBeGreaterThan(record);
    expect(caddy).toContain('import { recordConfigSnapshotAfterApply } from "@/ee/config-history/snapshots";');
  });
});

describe('the configuration', () => {
  it('covers exactly the settings groups that /api/v1/settings/{group} manages, and the certificate storage', () => {
    const route = source('app/api/v1/settings/[group]/route.ts');
    const storageKeys = [...route.matchAll(/storageKey: "([a-z_]+)"/g)].map((match) => match[1]);
    expect(storageKeys.length).toBeGreaterThan(10);
    // ee/high-availability manages its own settings group through /api/v1/high-availability/storage.
    expect([...CONFIG_SETTING_KEYS].sort()).toEqual([...new Set([...storageKeys, 'certificate_storage'])].sort());
  });
});

describe('feature flag, migration and navigation', () => {
  it('ships config_history in the Homelab edition', () => {
    expect(FEATURE_INFO.config_history).toMatchObject({ edition: 'homelab' });
  });

  it('has a migration for config_snapshots in the journal', () => {
    const journal = JSON.parse(source('drizzle/meta/_journal.json')) as { entries: { tag: string }[] };
    expect(journal.entries.map((entry) => entry.tag)).toContain('0027_config_history');
    expect(source('drizzle/0027_config_history.sql')).toContain('CREATE TABLE `config_snapshots`');
  });

  it('lists the History page for administrators', () => {
    expect(source('src/lib/navigation.ts'))
      .toMatch(/\{ href: "\/history", label: "Change history", permission: "config_history:read" \}/);
  });
});

describe('OpenAPI', () => {
  it('documents every configuration history and transfer endpoint', async () => {
    const { GET } = await import('@/app/api/v1/openapi.json/route');
    const spec = await (await GET(new NextRequest('http://localhost/api/v1/openapi.json'))).json();
    const operations = {
      '/api/v1/config-history': ['get', 'post', 'delete'],
      '/api/v1/config-history/settings': ['get', 'put'],
      '/api/v1/config-history/{id}': ['get', 'delete'],
      '/api/v1/config-history/{id}/diff': ['get'],
      '/api/v1/config-history/{id}/restore': ['post'],
      '/api/v1/config/export': ['post'],
      '/api/v1/config/import': ['post'],
    };
    const tags = spec.tags.map((tag: { name: string }) => tag.name);
    for (const [path, methods] of Object.entries(operations)) {
      for (const method of methods) {
        const operation = spec.paths[path]?.[method];
        expect(operation, `${method} ${path}`).toBeDefined();
        expect(operation.operationId).toEqual(expect.any(String));
        for (const tag of operation.tags) expect(tags).toContain(tag);
      }
    }
    // Every $ref in these operations and in the Config* schemas resolves.
    const documented = JSON.stringify([
      ...Object.keys(operations).map((path) => spec.paths[path]),
      ...Object.entries(spec.components.schemas).filter(([name]) => name.startsWith('Config')),
    ]);
    const refs = [...documented.matchAll(/"\$ref":"#\/components\/([^/]+)\/([^"]+)"/g)];
    expect(refs.length).toBeGreaterThan(10);
    for (const [, kind, name] of refs) expect(spec.components[kind]?.[name], `${kind}/${name}`).toBeDefined();
  });
});
