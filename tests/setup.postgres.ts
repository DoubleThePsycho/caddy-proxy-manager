/**
 * Setup file of the postgres Vitest project: the worker's own database, a
 * copy of the run's template (tests/global-setup.postgres.ts), created on the
 * worker's first test file. DATABASE_URL points at it before the test file
 * loads anything, so the schema module picks the PostgreSQL tables and the
 * application's pool, if a test uses it, connects there.
 */
import { ensureWorkerDatabase, PG_TEST_RUN_ENV } from './helpers/pg-test-db';

const run = process.env[PG_TEST_RUN_ENV];
if (!run) throw new Error(`${PG_TEST_RUN_ENV} is not set (tests/vitest.config.ts sets it)`);
process.env.DATABASE_URL = await ensureWorkerDatabase(run, process.env.VITEST_POOL_ID ?? '1');
