/**
 * Cached values (src/lib/db/cached-value.ts): read synchronously from
 * memory, loaded at start-up, read again by the code that changes them,
 * refreshed in the background after their TTL, and never left holding a
 * value a rolled-back transaction wrote.
 */
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db';
import { settings } from '../../src/lib/db/schema';
import { first } from '../../src/lib/db/ops';
import { cachedValuesSettled, defineCachedValue, loadCachedValues, refreshCachedValue } from '../../src/lib/db/cached-value';

let counter = 0;

/** A cached value over the settings row "k" of `db`, with a unique name. */
function cachedSetting(db: TestDb, options: { ttlMs?: number; fail?: () => boolean } = {}) {
  const reads = { count: 0 };
  const value = defineCachedValue<string>(`test value ${++counter}`, {
    load: async () => {
      reads.count += 1;
      if (options.fail?.()) throw new Error('database is locked');
      return (await first(db.select().from(settings).where(eq(settings.key, 'k')).limit(1)))?.value ?? 'none';
    },
    fallback: 'fallback',
    ttlMs: options.ttlMs,
  });
  return { value, reads };
}

async function setK(db: TestDb, value: string) {
  const updatedAt = new Date().toISOString();
  await db.insert(settings).values({ key: 'k', value, updatedAt }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } });
}

afterEach(async () => {
  vi.useRealTimers();
  await cachedValuesSettled();
});

describe('cached values', () => {
  it('returns the fallback before the first load and loads in the background', async () => {
    const db = createTestDb();
    await setK(db, 'one');
    const { value } = cachedSetting(db);
    expect(value.isLoaded()).toBe(false);
    expect(value.current()).toBe('fallback');
    await cachedValuesSettled();
    expect(value.current()).toBe('one');
    expect(value.isLoaded()).toBe(true);
  });

  it('is loaded by loadCachedValues and read again by changed()', async () => {
    const db = createTestDb();
    await setK(db, 'one');
    const { value, reads } = cachedSetting(db);
    await loadCachedValues();
    expect(value.current()).toBe('one');
    await setK(db, 'two');
    // Memory, not the database: unchanged until it is read again.
    expect(value.current()).toBe('one');
    expect(await value.changed()).toBe('two');
    expect(value.current()).toBe('two');
    const before = reads.count;
    value.current();
    expect(reads.count).toBe(before);
  });

  it('reads the transaction’s own write, and again after a rollback', async () => {
    const db = createTestDb();
    await setK(db, 'committed');
    const { value } = cachedSetting(db);
    await value.refresh();
    await expect(db.transaction(async () => {
      await setK(db, 'rolled back');
      expect(await value.changed()).toBe('rolled back');
      throw new Error('undo');
    })).rejects.toThrow('undo');
    await cachedValuesSettled();
    expect(value.current()).toBe('committed');
  });

  it('reads again only once the transaction has committed, so the old value never comes back', async () => {
    const db = createTestDb();
    await setK(db, 'one');
    const { value, reads } = cachedSetting(db);
    await value.refresh();
    await db.transaction(async () => {
      await setK(db, 'two');
      expect(await value.changed()).toBe('two');
      const before = reads.count;
      await new Promise((resolve) => setTimeout(resolve, 20));
      // No read from outside the transaction yet: on PostgreSQL it would still see 'one'.
      expect(reads.count).toBe(before);
      expect(value.current()).toBe('two');
    });
    await cachedValuesSettled();
    expect(value.current()).toBe('two');
  });

  it('refreshes in the background once older than its TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const db = createTestDb();
    await setK(db, 'one');
    const { value } = cachedSetting(db, { ttlMs: 10_000 });
    await value.refresh();
    await setK(db, 'two');
    vi.setSystemTime(new Date('2030-01-01T00:00:05.000Z'));
    expect(value.current()).toBe('one');
    await cachedValuesSettled();
    expect(value.current()).toBe('one');
    vi.setSystemTime(new Date('2030-01-01T00:00:11.000Z'));
    expect(value.current()).toBe('one');
    await cachedValuesSettled();
    expect(value.current()).toBe('two');
  });

  it('keeps the last value when a read fails, and changed() never throws', async () => {
    const db = createTestDb();
    await setK(db, 'one');
    let failing = false;
    const { value } = cachedSetting(db, { fail: () => failing });
    await value.refresh();
    failing = true;
    await expect(value.refresh()).rejects.toThrow('database is locked');
    expect(await value.changed()).toBe('one');
    expect(value.current()).toBe('one');
    failing = false;
    await setK(db, 'two');
    expect(await refreshCachedValue(value.name)).toBe(true);
    expect(value.current()).toBe('two');
    expect(await refreshCachedValue('no such value')).toBe(false);
  });

  it('never lets an older read overwrite a newer one', async () => {
    const db = createTestDb();
    await setK(db, 'one');
    const { value } = cachedSetting(db);
    const older = value.refresh();
    await setK(db, 'two');
    const newer = value.refresh();
    await Promise.all([older, newer]);
    expect(value.current()).toBe('two');
  });
});
