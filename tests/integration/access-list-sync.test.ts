/**
 * Access list rules reach replicas and the configuration snapshots:
 *  - instance sync carries access_list_rules (attribution cleared) and the
 *    lists' rule settings, a slave replaces its rules with the master's, and
 *    a payload from an older master (no rules, no settings) still applies;
 *  - the slave refuses rules and settings the dashboard would never write;
 *  - the sync fingerprint is unchanged while no list has rules;
 *  - configuration export/history (config-content.ts) and fleet revisions
 *    include the rules, and a restore drops rules of lists that are gone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => {
  const { mkdirSync } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const dir = join(tmpdir(), `access-list-sync-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  process.env.L4_PORTS_DIR = dir;
  return { db: null as unknown as TestDb };
});

vi.mock('../../src/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db');
  ctx.db = createTestDb();
  return (await import('../helpers/db-module')).mockDbModule(() => ctx.db);
});

import { applySyncPayload, buildSyncPayload, type SyncPayload } from '../../src/lib/instance-sync';
import { syncPayloadValidationError } from '../../src/lib/instance-sync-validation';
import { canonicalSyncContent } from '../../src/lib/instance-sync-fingerprint';
import { readCurrentConfigContent, writeConfigContent, parseConfigContent } from '../../src/lib/config-content';
import { toFleetContent } from '../../ee/fleet/revisions';
import { createAccessList, addBlockedSource } from '../../src/lib/models/access-lists';
import * as schema from '../../src/lib/db/schema';
import { appDb } from '../../src/lib/db';

const ADMIN = 1;

beforeEach(async () => {
  for (const table of [schema.proxyHosts, schema.accessListRules, schema.accessListEntries, schema.accessLists, schema.settings, schema.users]) {
    await ctx.db.delete(table);
  }
  const now = new Date().toISOString();
  await ctx.db.insert(schema.users).values({ id: ADMIN, email: 'admin@example.com', role: 'admin', status: 'active', createdAt: now, updatedAt: now });
});

function emptyPayload(): SyncPayload {
  return {
    generated_at: new Date().toISOString(),
    settings: {
      general: null, acme: null, cloudflare: null, dns_provider: null, authentik: null, metrics: null, logging: null,
      dns: null, upstream_dns_resolution: null, waf: null, geoblock: null, error_pages: null, trusted_proxies: null,
      default_response: null,
    },
    data: { certificates: [], caCertificates: [], issuedClientCertificates: [], accessLists: [], accessListEntries: [], proxyHosts: [] },
  };
}

const now = new Date().toISOString();
const listRow = (overrides: Record<string, unknown> = {}) => ({
  id: 7, name: 'Synced', description: null, createdBy: null, createdAt: now, updatedAt: now, organizationId: null,
  defaultAction: 'deny', denyStatus: 451, denyBody: 'No', denyRedirectUrl: null, failClosed: true, systemKey: null,
  ...overrides,
});
const ruleRow = (overrides: Record<string, unknown> = {}) => ({
  id: 3, accessListId: 7, position: 0, action: 'allow', kind: 'ip', matchValues: '["203.0.113.0/26"]', note: 'Office',
  expiresAt: null, createdBy: null, createdAt: now, updatedAt: now,
  ...overrides,
});

describe('instance sync', () => {
  it('sends the rules with attribution cleared, and the lists with their settings', async () => {
    const list = await createAccessList(
      { name: 'Office', defaultAction: 'deny', rules: [{ action: 'allow', kind: 'ip', values: ['203.0.113.0/26'] }] },
      ADMIN
    );
    await addBlockedSource({ address: '198.51.100.19', reason: 'Scanner' }, ADMIN);

    const payload = await buildSyncPayload();
    expect(payload.data.accessLists.find((row) => row.id === list.id)).toMatchObject({ defaultAction: 'deny', createdBy: null });
    expect(payload.data.accessLists.find((row) => row.systemKey === 'blocked_sources')).toBeDefined();
    expect(payload.data.accessListRules).toHaveLength(2);
    expect(payload.data.accessListRules!.every((rule) => rule.createdBy === null)).toBe(true);
    expect(syncPayloadValidationError(JSON.parse(JSON.stringify(payload)))).toBeNull();
  });

  it('replaces the slave rules with the master rules', async () => {
    const local = await createAccessList({ name: 'Local', rules: [{ action: 'deny', kind: 'ip', values: ['192.0.2.1'] }] }, ADMIN);
    const payload = emptyPayload();
    payload.data.accessLists = [listRow()] as SyncPayload['data']['accessLists'];
    payload.data.accessListRules = [ruleRow()] as SyncPayload['data']['accessListRules'];

    await applySyncPayload(payload);

    expect(await ctx.db.select().from(schema.accessLists)).toEqual([expect.objectContaining({ id: 7, defaultAction: 'deny', denyStatus: 451, failClosed: true })]);
    expect(await ctx.db.select().from(schema.accessListRules)).toEqual([expect.objectContaining({ id: 3, accessListId: 7, note: 'Office' })]);
    expect((await ctx.db.select().from(schema.accessListRules)).some((rule) => rule.accessListId === local.id)).toBe(false);
  });

  it('applies a payload from an older master: no rules, lists without settings', async () => {
    await createAccessList({ name: 'Local', rules: [{ action: 'deny', kind: 'ip', values: ['192.0.2.1'] }] }, ADMIN);
    const payload = emptyPayload();
    payload.data.accessLists = [{ id: 1, name: 'Old', description: null, createdBy: null, createdAt: now, updatedAt: now }] as SyncPayload['data']['accessLists'];
    expect(syncPayloadValidationError(payload)).toBeNull();

    await applySyncPayload(payload);

    expect(await ctx.db.select().from(schema.accessLists)).toEqual([
      expect.objectContaining({ name: 'Old', defaultAction: 'allow', denyStatus: 403, failClosed: false, systemKey: null }),
    ]);
    expect(await ctx.db.select().from(schema.accessListRules)).toEqual([]);
  });

  it('refuses rules and settings the dashboard would never write', () => {
    const withRule = (rule: Record<string, unknown>, list: Record<string, unknown> = {}) => {
      const payload = emptyPayload();
      payload.data.accessLists = [listRow(list)] as SyncPayload['data']['accessLists'];
      payload.data.accessListRules = [ruleRow(rule)] as SyncPayload['data']['accessListRules'];
      return syncPayloadValidationError(payload);
    };
    expect(withRule({})).toBeNull();
    expect(withRule({ matchValues: '["10.0.0.1/33"]' })).toMatch(/invalid value/);
    expect(withRule({ matchValues: '["{env.SECRET}"]' })).toMatch(/invalid value/);
    expect(withRule({ matchValues: '[]' })).toMatch(/is invalid/);
    expect(withRule({ matchValues: 'not json' })).toMatch(/is invalid/);
    expect(withRule({ kind: 'country', matchValues: '["ZZ"]' })).toMatch(/invalid value/);
    expect(withRule({ action: 'maybe' })).toMatch(/is invalid/);
    expect(withRule({ accessListId: 99 })).toMatch(/belongs to no access list/);
    expect(withRule({}, { denyStatus: 200 })).toMatch(/invalid rule settings/);
    expect(withRule({}, { denyRedirectUrl: 'javascript:alert(1)' })).toMatch(/invalid rule settings/);
    expect(withRule({}, { defaultAction: 'sometimes' })).toMatch(/invalid rule settings/);
    expect(withRule({}, { systemKey: 'superuser' })).toMatch(/unknown system key/);
    expect(withRule({ position: 'first' })).toBe('Invalid sync payload structure');
  });

  it('keeps the sync fingerprint of a configuration without rules unchanged', () => {
    const data = { accessLists: [], accessListEntries: [] };
    expect(canonicalSyncContent({ settings: {}, data: { ...data, accessListRules: [] } })).toBe(canonicalSyncContent({ settings: {}, data }));
    expect(canonicalSyncContent({ settings: {}, data: { ...data, accessListRules: [ruleRow()] } })).not.toBe(
      canonicalSyncContent({ settings: {}, data })
    );
    // Timestamps are not part of it.
    expect(canonicalSyncContent({ settings: {}, data: { ...data, accessListRules: [ruleRow({ updatedAt: 'later' })] } })).toBe(
      canonicalSyncContent({ settings: {}, data: { ...data, accessListRules: [ruleRow()] } })
    );
  });
});

describe('configuration content', () => {
  it('includes the rules, restores them and drops rules whose list is missing', async () => {
    const list = await createAccessList(
      { name: 'Office', defaultAction: 'deny', rules: [{ action: 'allow', kind: 'ip', values: ['203.0.113.0/26'] }] },
      ADMIN
    );
    const content = await readCurrentConfigContent();
    expect(content.tables.accessListRules).toEqual([expect.objectContaining({ accessListId: list.id, matchValues: '["203.0.113.0/26"]' })]);
    expect(content.tables.accessLists[0]).toMatchObject({ defaultAction: 'deny' });

    // Round trip through the strict parser (an export or a snapshot).
    const parsed = parseConfigContent(JSON.parse(JSON.stringify(content)));
    await ctx.db.delete(schema.accessListRules);
    await appDb.transaction(async (tx) => await writeConfigContent(tx, parsed, 'restore'));
    expect(await ctx.db.select().from(schema.accessListRules)).toHaveLength(1);

    // A rule of a list the content does not have is dropped.
    const orphan = { ...parsed, tables: { ...parsed.tables, accessListRules: [{ ...parsed.tables.accessListRules[0], id: 50, accessListId: 999 }] } };
    await appDb.transaction(async (tx) => await writeConfigContent(tx, orphan, 'import'));
    expect(await ctx.db.select().from(schema.accessListRules)).toEqual([]);
  });

  it('reads content from older releases without rules or list settings', async () => {
    const parsed = parseConfigContent({
      version: 1,
      tables: { accessLists: [{ id: 1, name: 'Old', description: null, createdBy: null, createdAt: now, updatedAt: now }] },
      settings: {},
    });
    expect(parsed.tables.accessListRules).toEqual([]);
    await appDb.transaction(async (tx) => await writeConfigContent(tx, parsed, 'import'));
    expect(await ctx.db.select().from(schema.accessLists)).toEqual([expect.objectContaining({ name: 'Old', defaultAction: 'allow' })]);
  });

  it('sends the rules to fleet revisions without attribution', async () => {
    await createAccessList({ name: 'Office', rules: [{ action: 'deny', kind: 'ip', values: ['192.0.2.1'] }] }, ADMIN);
    const fleet = toFleetContent(await readCurrentConfigContent());
    expect(fleet.tables.accessListRules).toEqual([expect.objectContaining({ createdBy: null })]);
  });
});
