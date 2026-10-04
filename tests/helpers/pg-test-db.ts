/**
 * Test databases on PostgreSQL (the `postgres` Vitest project,
 * TEST_DB_DIALECT=postgres; see tests/vitest.config.ts).
 *
 * - tests/global-setup.postgres.ts creates and migrates one template
 *   database per run on the server TEST_DATABASE_URL names.
 * - tests/setup.postgres.ts gives each Vitest worker its own database, a copy
 *   of the template, and points DATABASE_URL at it (the application's own
 *   pool, when a test uses it unmocked, connects there too).
 * - createTestDb() (tests/helpers/db.ts) returns the asynchronous facade over
 *   the worker's database after emptying every table (and restarting the
 *   identities, so ids start at 1 again, as in a new SQLite database). The
 *   second and later calls within one test (or one hook outside tests) get
 *   databases of their own (copies of the template too, made once per
 *   worker), so a test can still hold two databases (a master and a
 *   replica). Two calls in different tests reuse the same database, which
 *   the later call empties.
 */
import pg from 'pg';
import { expect } from 'vitest';
import { createPostgresExecutor, type PgPoolLike, type PostgresExecutor } from '../../src/lib/db/executor';
import { createPostgresPool, readPostgresConfig } from '../../src/lib/db/postgres';
import type { AppDb } from '../../src/lib/db/types';

/** Names this run's databases (set by tests/vitest.config.ts). */
export const PG_TEST_RUN_ENV = 'INGRESSI_PG_TEST_RUN';

/** The template database of run `run`, which every worker database copies. */
export function templateDatabaseName(run: string): string {
  if (!/^[a-z0-9]{1,16}$/.test(run)) throw new Error(`invalid test run id "${run}"`);
  return `ingressi_t_${run}`;
}

/** The database of Vitest worker `worker` (VITEST_POOL_ID) in run `run`. */
export function workerDatabaseName(run: string, worker: string): string {
  if (!/^\d{1,4}$/.test(worker)) throw new Error(`invalid worker id "${worker}"`);
  return `${templateDatabaseName(run)}_w${worker}`;
}

/** `serverUrl` with its database replaced by `database`. */
export function databaseUrl(serverUrl: string, database: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Runs `fn` with a connection to the server's maintenance database (TEST_DATABASE_URL). */
export async function withTestServer<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'The postgres test project needs TEST_DATABASE_URL: a disposable PostgreSQL server whose user may create databases'
    );
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * The schema of the database `client` is connected to, as a hash: tables,
 * columns, indexes, constraints and triggers. A test that drops or changes
 * part of the schema changes it.
 */
const SCHEMA_FINGERPRINT = `SELECT md5(concat_ws('|',
  (SELECT string_agg(table_name || '.' || column_name || ':' || data_type || ':' || coalesce(column_default, '') || ':' || is_nullable, ',' ORDER BY table_name, column_name)
     FROM information_schema.columns WHERE table_schema = 'public'),
  (SELECT string_agg(indexdef, ',' ORDER BY indexdef) FROM pg_indexes WHERE schemaname = 'public'),
  (SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint WHERE connamespace = 'public'::regnamespace),
  (SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE NOT tgisinternal)
)) AS fingerprint`;

/**
 * Records the template's schema fingerprint in it (schema ingressi_test,
 * which emptying the database leaves alone), so every copy knows what it
 * started as.
 */
export async function recordSchemaFingerprint(client: Pick<pg.Client, 'query'>): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ingressi_test;
    DROP TABLE IF EXISTS ingressi_test.meta;
    CREATE TABLE ingressi_test.meta AS ${SCHEMA_FINGERPRINT}`);
}

/** Whether the database at `url` still has the schema its template had. */
async function schemaIntact(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ intact: boolean }>(
      `SELECT (${SCHEMA_FINGERPRINT}) = (SELECT fingerprint FROM ingressi_test.meta) AS intact`
    );
    return rows[0]?.intact === true;
  } catch {
    return false;
  } finally {
    await client.end();
  }
}

/** Runs `fn` on the server under the lock that serialises creating test databases. */
function withDatabaseLock<T>(fn: (server: pg.Client) => Promise<T>): Promise<T> {
  return withTestServer(async (server) => {
    await server.query("SELECT pg_advisory_lock(hashtext('ingressi-test-databases'))");
    try {
      return await fn(server);
    } finally {
      await server.query("SELECT pg_advisory_unlock(hashtext('ingressi-test-databases'))");
    }
  });
}

/** Drops the database `name` (closing its connections) and copies the template again. */
async function recreateDatabase(run: string, name: string): Promise<void> {
  await withDatabaseLock(async (server) => {
    await server.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await server.query(`CREATE DATABASE "${name}" TEMPLATE "${templateDatabaseName(run)}"`);
  });
}

/**
 * Creates the worker's database (or its extra database `extra`) from the
 * template unless it exists, and copies it again when an earlier test file
 * changed its schema; returns its URL.
 */
export async function ensureWorkerDatabase(run: string, worker: string, extra?: number): Promise<string> {
  const name = extra === undefined ? workerDatabaseName(run, worker) : `${workerDatabaseName(run, worker)}_${extra}`;
  const created = await withDatabaseLock(async (server) => {
    const { rows } = await server.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (rows.length > 0) return false;
    await server.query(`CREATE DATABASE "${name}" TEMPLATE "${templateDatabaseName(run)}"`);
    return true;
  });
  const url = databaseUrl(process.env.TEST_DATABASE_URL!, name);
  if (!created && !(await schemaIntact(url))) await recreateDatabase(run, name);
  return url;
}

// ── Test databases ──

type PgTestState = {
  pools: Map<string, pg.Pool>;
  /** The statement that empties a database (built once per process). */
  emptying?: string;
  /** The latest emptying of each database (by URL): the next one waits for it. */
  pending: Map<string, Promise<void>>;
  /** The extra databases of this worker (2, 3, …), by number: their URLs once they exist. */
  extra: Map<number, Promise<string>>;
  /** The test (or hook) the last createTestDb() call came from, and how many it made. */
  phase?: string;
  calls: number;
};

const state: PgTestState = ((globalThis as { __ingressiPgTestDb?: PgTestState }).__ingressiPgTestDb ??= {
  pools: new Map(),
  pending: new Map(),
  extra: new Map(),
  calls: 0,
});

function workerUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url || !/^postgres(?:ql)?:\/\//.test(url)) {
    throw new Error('A PostgreSQL test database needs the postgres Vitest project (tests/setup.postgres.ts sets DATABASE_URL)');
  }
  return url;
}

function poolFor(url: string): pg.Pool {
  let pool = state.pools.get(url);
  if (!pool) {
    pool = createPostgresPool(readPostgresConfig({ DATABASE_URL: url, DATABASE_POOL_MAX: '6' }));
    state.pools.set(url, pool);
  }
  return pool;
}

/** The pool on the worker's database that test databases share. */
export function testPool(): pg.Pool {
  return poolFor(workerUrl());
}

/** The worker's extra database `number` (2, 3, …), created from the template on first use. */
function extraDatabase(number: number): Promise<string> {
  let url = state.extra.get(number);
  if (!url) {
    const run = process.env[PG_TEST_RUN_ENV];
    if (!run) throw new Error(`${PG_TEST_RUN_ENV} is not set (tests/vitest.config.ts sets it)`);
    url = ensureWorkerDatabase(run, `${process.env.VITEST_POOL_ID ?? '1'}`, number);
    state.extra.set(number, url);
  }
  return url;
}

/** The SQLSTATE of "relation does not exist". */
const UNDEFINED_TABLE = '42P01';

/**
 * The statement that empties every table and restarts every identity at 1.
 * DELETE and setval rather than TRUNCATE … RESTART IDENTITY: TRUNCATE gives
 * every table and index new files, thousands per test file, and a server
 * whose data lives in memory (tmpfs) runs out of inodes before checkpoints
 * remove the old ones.
 */
async function emptyingStatement(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query<{ deletes: string | null; restarts: string | null }>(
    `SELECT
       (SELECT string_agg(format('DELETE FROM %I.%I', schemaname, tablename), '; ' ORDER BY tablename)
          FROM pg_tables WHERE schemaname = 'public') AS deletes,
       (SELECT string_agg(format('SELECT setval(%L, 1, false)',
                 pg_get_serial_sequence(format('%I.%I', table_schema, table_name), column_name)), '; ' ORDER BY table_name)
          FROM information_schema.columns WHERE table_schema = 'public' AND is_identity = 'YES') AS restarts`
  );
  return [rows[0]?.deletes, rows[0]?.restarts].filter(Boolean).join('; ') || 'SELECT 1';
}

/**
 * Empties every table. When a table is gone (a test dropped it), the
 * database is copied from the template again first.
 */
async function emptyDatabase(url: string, pool: pg.Pool): Promise<void> {
  state.emptying ??= await emptyingStatement(pool);
  try {
    await pool.query(state.emptying);
  } catch (error) {
    const run = process.env[PG_TEST_RUN_ENV];
    if ((error as { code?: unknown }).code !== UNDEFINED_TABLE || !run) throw error;
    await recreateDatabase(run, new URL(url).pathname.slice(1));
    // The pool's idle connections to the old database were closed: the
    // first tries may get one of them.
    for (let attempt = 1; ; attempt++) {
      try {
        await pool.query(state.emptying);
        return;
      } catch (retryError) {
        if (attempt >= 5) throw retryError;
      }
    }
  }
}

/** A pool that waits for `ready` (which gives the pool) before every use. */
function afterReady(ready: Promise<pg.Pool>): PgPoolLike {
  return {
    query: async (config, values) => (await ready).query(config, values),
    connect: async () => (await ready).connect(),
  };
}

/** Which test or hook is running (tests/helpers/db.ts calls come from one at a time). */
function currentPhase(): string {
  const { testPath, currentTestName } = expect.getState();
  return `${testPath ?? ''}\u0000${currentTestName ?? ''}`;
}

/**
 * The asynchronous facade over a database of the worker, emptied first (its
 * first query waits for that). `$client` is the pg pool of the worker's
 * main database.
 */
export function createPgTestDb<T extends AppDb>(): T {
  const phase = currentPhase();
  if (phase !== state.phase) {
    state.phase = phase;
    state.calls = 0;
  }
  const number = ++state.calls;
  const url = number === 1 ? Promise.resolve(workerUrl()) : extraDatabase(number);
  const ready = url.then((resolved) => {
    const pool = poolFor(resolved);
    const emptied = (state.pending.get(resolved) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => emptyDatabase(resolved, pool));
    state.pending.set(resolved, emptied);
    return emptied.then(() => pool);
  });
  // Unhandled until a query awaits it; the query reports the error.
  ready.catch(() => undefined);
  return createPostgresExecutor(afterReady(ready), {
    casing: 'snake_case',
    client: number === 1 ? testPool() : undefined,
  }).db as T;
}

/**
 * Another process on the same database, standing for a second replica: an
 * executor with a pool of its own on the worker's database (not emptied).
 */
export function createPgReplica(): { db: AppDb; executor: PostgresExecutor; pool: pg.Pool; close(): Promise<void> } {
  const pool = createPostgresPool(readPostgresConfig({ DATABASE_URL: workerUrl(), DATABASE_POOL_MAX: '4' }));
  const executor = createPostgresExecutor(pool, { casing: 'snake_case', client: pool });
  return { db: executor.db, executor, pool, close: () => pool.end() };
}
