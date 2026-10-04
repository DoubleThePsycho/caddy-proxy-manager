/**
 * `@/src/lib/db` for tests that run production code against a test
 * database (tests/helpers/db.ts):
 *
 *   const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));
 *   vi.mock('@/src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
 *
 * Every database export (`default`, `appDb`, `db`) is whatever `getDb()`
 * returns when it is read, so a test can swap databases between tests.
 * `overrides` replaces or adds exports.
 */
import * as schema from '../../src/lib/db/schema';

export function nowIso(): string {
  return new Date().toISOString();
}

export function toIso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function mockDbModule(getDb: () => unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const exports: Record<string, unknown> = {
    get default() {
      return getDb();
    },
    get appDb() {
      return getDb();
    },
    get db() {
      return getDb();
    },
    get sqlite() {
      return (getDb() as { $client?: unknown } | null | undefined)?.$client;
    },
    schema,
    nowIso,
    toIso,
    restrictDatabaseFileModes: () => {},
    purgeDeletedDatabaseContent: async () => false,
  };
  return Object.defineProperties(exports, Object.getOwnPropertyDescriptors(overrides));
}
