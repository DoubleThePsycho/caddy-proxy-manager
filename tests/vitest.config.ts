import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { listTestFiles, postgresTestFiles, readSqliteOnlyList } from './helpers/database-test-files';

const root = resolve(__dirname, '..');

const ALL_TESTS = [
  resolve(__dirname, 'unit/**/*.test.ts'),
  resolve(__dirname, 'integration/**/*.test.ts'),
];

const COMMON_ENV = {
  SESSION_SECRET: 'test-session-secret-for-vitest-unit-tests-12345',
  NODE_ENV: 'test',
  // Never probe a real Caddy from the tests (src/lib/managed-certificates.ts).
  CADDY_TLS_ADDRESS: 'off',
} as const;

/**
 * The test files the postgres project runs: every one that imports the
 * database layer, directly or not, except those tests/sqlite-only.json lists
 * with the reason (tests/helpers/database-test-files.ts). Nothing to list
 * for a new database test: it runs on PostgreSQL by default.
 */
function postgresTests(): string[] {
  const files = listTestFiles([resolve(__dirname, 'unit'), resolve(__dirname, 'integration')]);
  return postgresTestFiles(files, root, readSqliteOnlyList(resolve(__dirname, 'sqlite-only.json')));
}

// Projects: `sqlite` (the default: every test on in-memory SQLite) and, with
// TEST_DB_DIALECT=postgres, `postgres` (the database tests, as above, on the
// PostgreSQL server TEST_DATABASE_URL names; tests/helpers/pg-test-db.ts).
//   bun run test       the sqlite project
//   bun run test:pg    the postgres project
const withPostgres = process.env.TEST_DB_DIALECT === 'postgres';
// Names this run's PostgreSQL databases; shared by the global setup (this
// process) and the workers (the project's env).
const pgRun = (process.env.INGRESSI_PG_TEST_RUN ??= randomBytes(4).toString('hex'));

export default defineConfig({
  plugins: [tsconfigPaths({ root })],
  resolve: {
    alias: {
      // bun:sqlite is a Bun built-in unavailable in Node.js/Vitest. Redirect both
      // the protocol import and the drizzle bun-sqlite adapter to their better-sqlite3
      // equivalents so tests that transitively import src/lib/db.ts don't crash.
      // Tests that need a real database use tests/helpers/db.ts (better-sqlite3 directly).
      'bun:sqlite': resolve(__dirname, 'helpers/bun-sqlite-compat.ts'),
      'drizzle-orm/bun-sqlite/migrator': 'drizzle-orm/better-sqlite3/migrator',
      'drizzle-orm/bun-sqlite': 'drizzle-orm/better-sqlite3',
      // next/font/google is compiled away by Next.js; tests get plain objects.
      'next/font/google': resolve(__dirname, 'helpers/next-font-google.ts'),
    },
  },
  test: {
    environment: 'node',
    setupFiles: [resolve(__dirname, 'setup.vitest.ts')],
    // Suppress console output from production code during tests (e.g. expected
    // warn/error calls when intentionally feeding bad input to parsers).
    // Tests that need to assert on console calls can still use vi.spyOn(console, ...).
    onConsoleLog() {
      return false;
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'sqlite',
          env: { ...COMMON_ENV, DATABASE_URL: ':memory:' },
          include: ALL_TESTS,
        },
      },
      ...(withPostgres
        ? [
            {
              extends: true,
              test: {
                name: 'postgres',
                env: {
                  ...COMMON_ENV,
                  TEST_DB_DIALECT: 'postgres',
                  DATABASE_DIALECT: 'postgres',
                  // tests/setup.postgres.ts replaces it with the worker's database.
                  DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
                  DATABASE_POOL_MAX: '4',
                  INGRESSI_PG_TEST_RUN: pgRun,
                },
                include: postgresTests(),
                globalSetup: [resolve(__dirname, 'global-setup.postgres.ts')],
                setupFiles: [resolve(__dirname, 'setup.postgres.ts')],
              },
            },
          ]
        : []),
    ],
  },
});
