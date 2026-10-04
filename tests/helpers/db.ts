import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import * as schema from '../../src/lib/db/schema';
import { createSqliteExecutor } from '../../src/lib/db/executor';
import { execRaw } from '../../src/lib/db/ops';
import type { AppDb } from '../../src/lib/db/types';
import { createPgTestDb } from './pg-test-db';

const migrationsFolder = resolve(process.cwd(), 'drizzle');

/**
 * A test database: the asynchronous facade (src/lib/db/executor.ts) over a
 * fresh in-memory SQLite database, what production code sees as `appDb`.
 * Await every query; `db.transaction` runs through the database's own gate.
 * `$client` is the better-sqlite3 connection, for raw assertions.
 *
 * In the postgres Vitest project (TEST_DB_DIALECT=postgres) it is the
 * facade over the worker's PostgreSQL database, emptied, and `$client` is
 * the pg pool (tests/helpers/pg-test-db.ts).
 */
export type TestDb = AppDb & { $client: Database.Database };

/**
 * The synchronous Drizzle instance over a test database, for the few tests
 * that need raw, synchronous access (migrations, driver behaviour).
 */
export type SyncTestDb = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** Whether test databases are PostgreSQL ones (the postgres Vitest project). */
export function testDbIsPostgres(): boolean {
  return process.env.TEST_DB_DIALECT === 'postgres';
}

/**
 * Creates a fresh in-memory SQLite database with all migrations applied.
 * Each call returns a completely isolated database: the asynchronous facade
 * by default, the synchronous Drizzle instance with `{ sync: true }`
 * (SQLite only). On PostgreSQL, see TestDb.
 */
export function createTestDb(): TestDb;
export function createTestDb(options: { sync: true }): SyncTestDb;
export function createTestDb(options: { sync?: false }): TestDb;
export function createTestDb(options: { sync?: boolean } = {}): TestDb | SyncTestDb {
  if (testDbIsPostgres()) {
    if (options.sync) throw new Error('createTestDb({ sync: true }) is SQLite only: this test cannot run on PostgreSQL');
    return createPgTestDb<TestDb>();
  }
  const sqlite = new Database(':memory:');
  const sync = drizzle(sqlite, { schema, casing: 'snake_case' }) as SyncTestDb;
  migrate(sync, { migrationsFolder });
  if (options.sync) return sync;
  return createSqliteExecutor(sqlite, { casing: 'snake_case', exposeClient: true }).db as TestDb;
}

/**
 * The synchronous Drizzle instance over the same connection as `db`, for raw
 * access in a test (it does not wait for the facade's transactions).
 */
export function syncTestDb(db: TestDb): SyncTestDb {
  if (testDbIsPostgres()) throw new Error('syncTestDb is SQLite only: this test cannot run on PostgreSQL');
  return drizzle(db.$client, { schema, casing: 'snake_case' }) as SyncTestDb;
}

/**
 * Turns SQLite's foreign key enforcement off on `db`, as the application
 * runs (its schema declares foreign keys it does not enforce). PostgreSQL
 * databases have no foreign keys: nothing to do there.
 */
export async function disableForeignKeys(db: TestDb): Promise<void> {
  if (testDbIsPostgres()) return;
  await execRaw(sql`PRAGMA foreign_keys = OFF`, db);
}
