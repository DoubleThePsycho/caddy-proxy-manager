/**
 * Global setup of the postgres Vitest project (tests/vitest.config.ts): one
 * template database for the run on the server TEST_DATABASE_URL names,
 * migrated by the application's own start-up code (which also checks the
 * server version and the C collation), with its schema fingerprint. Every
 * worker copies it (tests/setup.postgres.ts). The teardown drops the template
 * and the copies.
 */
import { preparePostgresDatabase } from '../src/lib/db/pg-startup';
import { createPostgresPool, readPostgresConfig } from '../src/lib/db/postgres';
import pg from 'pg';
import {
  databaseUrl,
  PG_TEST_RUN_ENV,
  recordSchemaFingerprint,
  templateDatabaseName,
  withTestServer,
} from './helpers/pg-test-db';

async function dropRunDatabases(run: string): Promise<void> {
  const template = templateDatabaseName(run);
  await withTestServer(async (server) => {
    const { rows } = await server.query<{ name: string }>(
      "SELECT datname AS name FROM pg_database WHERE datname = $1 OR datname LIKE $1 || '\\_w%'",
      [template]
    );
    for (const { name } of rows) await server.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  });
}

export default async function setup(): Promise<() => Promise<void>> {
  const run = process.env[PG_TEST_RUN_ENV];
  if (!run) throw new Error(`${PG_TEST_RUN_ENV} is not set (tests/vitest.config.ts sets it)`);
  const template = templateDatabaseName(run);
  await dropRunDatabases(run);
  await withTestServer((server) =>
    server.query(`CREATE DATABASE "${template}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`)
  );
  const url = databaseUrl(process.env.TEST_DATABASE_URL!, template);
  const pool = createPostgresPool(readPostgresConfig({ DATABASE_URL: url }));
  try {
    await preparePostgresDatabase(pool);
  } finally {
    await pool.end();
  }
  // What every copy starts as (tests/helpers/pg-test-db.ts checks it).
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await recordSchemaFingerprint(client);
  } finally {
    await client.end();
  }
  return () => dropRunDatabases(run);
}
