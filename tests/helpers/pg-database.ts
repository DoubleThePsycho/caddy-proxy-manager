/**
 * A throwaway PostgreSQL database for tests that run against a real server
 * (tests/integration/pg/). TEST_DATABASE_URL names a database on a disposable
 * server whose user may create databases; each test file creates its own
 * database there and drops it at the end. Without TEST_DATABASE_URL the
 * PostgreSQL tests are skipped.
 */
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** The PostgreSQL migrations (drizzle-pg/README.md). */
export const PG_MIGRATIONS_FOLDER = resolve(process.cwd(), 'drizzle-pg');

export type PgTestDatabase = {
  name: string;
  client: Client;
  /** Closes the connection and drops the database. */
  drop(): Promise<void>;
};

async function withServer<T>(run: (client: Client) => Promise<T>): Promise<T> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set');
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/**
 * Creates an empty database with the encoding, collation and character
 * classification the application requires (UTF8, C, C) and connects to it.
 * `label` (lowercase letters, digits and underscores) names it in the
 * server's list, next to a random suffix.
 */
export async function createPgTestDatabase(label: string): Promise<PgTestDatabase> {
  if (!/^[a-z0-9_]{1,30}$/.test(label)) throw new Error(`invalid database label "${label}"`);
  const name = `ingressi_test_${label}_${randomBytes(4).toString('hex')}`;
  await withServer((server) =>
    server.query(`CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`)
  );
  const url = new URL(TEST_DATABASE_URL!);
  url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  return {
    name,
    client,
    async drop() {
      await client.end().catch(() => undefined);
      await withServer((server) => server.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    },
  };
}

/** Applies drizzle-pg/ with Drizzle's PostgreSQL migrator. */
export async function migratePgDatabase(client: Client, migrationsFolder = PG_MIGRATIONS_FOLDER): Promise<void> {
  await migrate(drizzle(client), { migrationsFolder });
}
