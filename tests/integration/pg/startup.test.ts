/**
 * PostgreSQL start-up (src/lib/db/pg-startup.ts) against a real server:
 * replicas that start together migrate the database once, one after the
 * other; a database a newer version migrated is refused (D8), and so is one
 * without the C collation and character classification (D2). Each test
 * creates its own databases; skipped without TEST_DATABASE_URL.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  DatabaseStartupError,
  newestMigrationWhen,
  preparePostgresDatabase,
} from '../../../src/lib/db/pg-startup';
import { createPostgresPool, readPostgresConfig } from '../../../src/lib/db/postgres';
import { createPgTestDatabase, TEST_DATABASE_URL, type PgTestDatabase } from '../../helpers/pg-database';
import { databaseUrl, withTestServer } from '../../helpers/pg-test-db';

const cleanup: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const step of cleanup.reverse()) await step().catch(() => undefined);
});

async function database(label: string): Promise<{ database: PgTestDatabase; pool: () => pg.Pool }> {
  const created = await createPgTestDatabase(label);
  cleanup.push(() => created.drop());
  return {
    database: created,
    pool: () => {
      const pool = createPostgresPool(readPostgresConfig({ DATABASE_URL: databaseUrl(TEST_DATABASE_URL!, created.name) }));
      cleanup.unshift(() => pool.end());
      return pool;
    },
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(!TEST_DATABASE_URL)('PostgreSQL start-up', () => {
  it('migrates an empty database once when replicas start together, one after the other', async () => {
    const { database: created, pool } = await database('startup_race');
    const events: string[] = [];
    const replica = (name: string) => preparePostgresDatabase(pool(), {
      then: async () => {
        events.push(`${name} start`);
        await sleep(30);
        events.push(`${name} end`);
      },
    });
    await Promise.all([replica('a'), replica('b')]);
    expect(events).toHaveLength(4);
    expect(events[1]).toBe(`${events[0].split(' ')[0]} end`);

    const { rows } = await created.client.query<{ count: string; newest: string }>(
      'SELECT count(*) AS count, max(created_at) AS newest FROM drizzle.__drizzle_migrations'
    );
    const journal = (await import('../../../drizzle-pg/meta/_journal.json')).default as { entries: unknown[] };
    expect(Number(rows[0].count)).toBe(journal.entries.length);
    expect(Number(rows[0].newest)).toBe(newestMigrationWhen());
    const { rows: tables } = await created.client.query("SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users'");
    expect(tables).toHaveLength(1);

    // Starting again changes nothing.
    await preparePostgresDatabase(pool());
    const { rows: again } = await created.client.query<{ count: string }>('SELECT count(*) AS count FROM drizzle.__drizzle_migrations');
    expect(Number(again[0].count)).toBe(journal.entries.length);
  });

  it('refuses a database a newer version of Ingressi migrated', async () => {
    const { database: created, pool } = await database('startup_newer');
    await preparePostgresDatabase(pool());
    await created.client.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', [
      'from-a-newer-version',
      newestMigrationWhen() + 86_400_000,
    ]);
    const error = await preparePostgresDatabase(pool()).then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(DatabaseStartupError);
    expect((error as Error).message).toMatch(/migrated by a newer version of Ingressi/);
    expect((error as Error).message).toMatch(/stop every replica/);
    // The migration lock was released: a check from elsewhere does not wait.
    const { rows } = await created.client.query<{ got: boolean }>('SELECT pg_try_advisory_lock(1768843115, 2) AS got');
    expect(rows[0].got).toBe(true);
  });

  it('refuses a database without the C collation and character classification', async (context) => {
    const name = `ingressi_test_startup_locale_${Date.now().toString(36)}`;
    const created = await withTestServer(async (server) => {
      for (const options of [
        "LOCALE_PROVIDER icu ICU_LOCALE 'en-US' LC_COLLATE 'C' LC_CTYPE 'C'",
        "LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8'",
      ]) {
        try {
          await server.query(`CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8' ${options}`);
          return true;
        } catch {
          // This server lacks that locale provider or locale; try the next.
        }
      }
      return false;
    });
    if (!created) {
      context.skip();
      return;
    }
    cleanup.push(() => withTestServer((server) => server.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)).then(() => undefined));
    const pool = createPostgresPool(readPostgresConfig({ DATABASE_URL: databaseUrl(TEST_DATABASE_URL!, name) }));
    try {
      const error = await preparePostgresDatabase(pool).then(() => null, (failure: unknown) => failure);
      expect(error).toBeInstanceOf(DatabaseStartupError);
      expect((error as Error).message).toMatch(/C collation and character classification/);
      expect((error as Error).message).toContain(`CREATE DATABASE "${name}" TEMPLATE template0`);
      // Nothing was migrated.
      const { rows } = await pool.query<{ present: boolean }>("SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present");
      expect(rows[0].present).toBe(false);
    } finally {
      await pool.end();
    }
  });
});
