/**
 * The rate limiting defaults (settings key rate_limit) reach sync slaves:
 * the master sends them, a slave stores them as its synced value (a local
 * override still wins), a payload from an older master clears them, and the
 * group is part of configuration export and history. The drift fingerprint
 * leaves the group out while it is unset, so masters and slaves of releases
 * before rate limiting keep agreeing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => {
  const { mkdirSync } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const dir = join(tmpdir(), `rate-limit-sync-test-${Date.now()}`);
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
import { canonicalSyncContent } from '../../src/lib/instance-sync-fingerprint';
import { CONFIG_SETTING_KEYS, CONFIG_SETTING_LABELS } from '../../src/lib/config-content';
import { getRateLimitSettings, getSetting, saveRateLimitSettings, setSetting } from '../../src/lib/settings';
import * as schema from '../../src/lib/db/schema';

const defaults = {
  enabled: true,
  rules: [{ path: '/login', methods: ['POST'], key: 'client_ip' as const, events: 5, window: '1m' }],
  allowlist: ['192.0.2.0/24'],
  ipv6Prefix: 64,
};

beforeEach(async () => {
  delete process.env.INSTANCE_MODE;
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.settings);
});

describe('instance sync of the rate limiting defaults', () => {
  it('sends the stored defaults to slaves', async () => {
    expect((await buildSyncPayload()).settings.rate_limit).toBeNull();
    await saveRateLimitSettings(defaults);
    expect((await buildSyncPayload()).settings.rate_limit).toEqual(defaults);
  });

  it('stores them on the slave, where a local override wins', async () => {
    await saveRateLimitSettings(defaults);
    const payload = await buildSyncPayload();
    await ctx.db.delete(schema.settings);

    process.env.INSTANCE_MODE = 'slave';
    await applySyncPayload(payload);
    expect(await getSetting('synced:rate_limit')).toEqual(defaults);
    expect(await getRateLimitSettings()).toEqual(defaults);

    await setSetting('rate_limit', { enabled: false, rules: [], allowlist: [] });
    expect(await getRateLimitSettings()).toEqual({ enabled: false, rules: [], allowlist: [] });
  });

  it('clears them when an older master sends no rate_limit group', async () => {
    await saveRateLimitSettings(defaults);
    const payload = await buildSyncPayload();
    await ctx.db.delete(schema.settings);
    process.env.INSTANCE_MODE = 'slave';
    await applySyncPayload(payload);

    const { rate_limit: _omitted, ...olderSettings } = payload.settings;
    void _omitted;
    await applySyncPayload({ ...payload, settings: olderSettings } as SyncPayload);
    expect(await getSetting('synced:rate_limit')).toBeNull();
    expect(await getRateLimitSettings()).toBeNull();
  });

  it('leaves the group out of the drift fingerprint while unset', () => {
    const data = { proxyHosts: [] };
    const older = canonicalSyncContent({ settings: { general: { primaryDomain: 'example.com' } }, data });
    expect(canonicalSyncContent({ settings: { general: { primaryDomain: 'example.com' }, rate_limit: null }, data })).toBe(older);
    const withDefaults = canonicalSyncContent({ settings: { general: { primaryDomain: 'example.com' }, rate_limit: defaults }, data });
    expect(withDefaults).not.toBe(older);
    expect(withDefaults).toContain('"rate_limit"');
  });

  it('is part of configuration export and history', () => {
    expect(CONFIG_SETTING_KEYS).toContain('rate_limit');
    expect(CONFIG_SETTING_LABELS.rate_limit).toBe('Rate limiting');
  });
});
