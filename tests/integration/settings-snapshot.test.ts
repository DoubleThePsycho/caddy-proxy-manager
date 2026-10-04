/**
 * withSettingsSnapshot (src/lib/settings.ts): inside it, every setting is
 * read from the database once, the keys it names in one query, so the Caddy
 * configuration build does not read the instance mode before every setting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db';
import { countStatements, type StatementCounter } from '../helpers/statement-counter';
import { settings } from '../../src/lib/db/schema';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('@/src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

import {
  clearSetting,
  getEffectiveSetting,
  getGeneralSettings,
  getInstanceModeForSettings,
  getSetting,
  setSetting,
  withSettingsSnapshot,
} from '../../src/lib/settings';

const NOW = '2026-10-01T00:00:00.000Z';

async function store(key: string, value: unknown) {
  await ctx.db.insert(settings).values({ key, value: JSON.stringify(value), updatedAt: NOW });
}

/** The statements that read the settings table. */
function settingsReads(counter: StatementCounter): string[] {
  return counter.statements.filter((statement) => /from "settings"/.test(statement));
}

describe('withSettingsSnapshot', () => {
  let counter: StatementCounter | null = null;
  const originalMode = process.env.INSTANCE_MODE;

  beforeEach(async () => {
    ctx.db = createTestDb();
    delete process.env.INSTANCE_MODE;
    await store('general', { primaryDomain: 'example.com' });
    await store('acme', { email: 'admin@example.com' });
  });

  afterEach(() => {
    counter?.stop();
    counter = null;
    if (originalMode === undefined) delete process.env.INSTANCE_MODE;
    else process.env.INSTANCE_MODE = originalMode;
  });

  it('reads the named keys, their synced copies and the instance mode in one query', async () => {
    counter = countStatements(ctx.db);
    const values = await withSettingsSnapshot(['general', 'acme', 'dns'], async () => [
      await getGeneralSettings(),
      await getEffectiveSetting('acme'),
      await getEffectiveSetting('dns'),
      await getEffectiveSetting('general'),
      await getInstanceModeForSettings(),
    ]);

    expect(values).toEqual([{ primaryDomain: 'example.com' }, { email: 'admin@example.com' }, null, { primaryDomain: 'example.com' }, 'standalone']);
    expect(settingsReads(counter)).toHaveLength(1);
  });

  it('reads a key it was not given once, when first asked for', async () => {
    await store('metrics', { enabled: true });
    counter = countStatements(ctx.db);
    await withSettingsSnapshot(['general'], async () => {
      expect(await getSetting('metrics')).toEqual({ enabled: true });
      expect(await getSetting('metrics')).toEqual({ enabled: true });
    });

    expect(settingsReads(counter)).toHaveLength(2);
  });

  it('serves a slave the synced copy where it has no value of its own', async () => {
    await store('instance_mode', 'slave');
    await store('synced:dns', { resolvers: ['192.0.2.53'] });
    counter = countStatements(ctx.db);
    const dns = await withSettingsSnapshot(['dns'], async () => await getEffectiveSetting('dns'));

    expect(dns).toEqual({ resolvers: ['192.0.2.53'] });
    expect(settingsReads(counter)).toHaveLength(1);
  });

  it('reads back what it writes, and reads from the database again once it ends', async () => {
    await withSettingsSnapshot(['general'], async () => {
      await setSetting('general', { primaryDomain: 'example.org' });
      expect(await getGeneralSettings()).toEqual({ primaryDomain: 'example.org' });
      await clearSetting('general');
      expect(await getGeneralSettings()).toBeNull();
    });
    await store('general', { primaryDomain: 'example.net' });

    expect(await getGeneralSettings()).toEqual({ primaryDomain: 'example.net' });
  });

  it('gives every caller its own copy of a value', async () => {
    await withSettingsSnapshot(['general'], async () => {
      const first = await getGeneralSettings();
      first!.primaryDomain = 'changed.example.com';
      expect(await getGeneralSettings()).toEqual({ primaryDomain: 'example.com' });
    });
  });
});
