/**
 * The application's own database (src/lib/db, unmocked) for tests that boot
 * the real db module and auth server (Better Auth) on it: a SQLite file in a
 * temporary directory (DATABASE_URL=file:…), or, in the postgres Vitest
 * project, the worker's PostgreSQL database (tests/setup.postgres.ts),
 * emptied, through the application's own pool and executor.
 *
 *   let database: AppDatabase;
 *   beforeAll(async () => {
 *     database = await openAppDatabase('ingressi-mfa-');
 *     vi.resetModules();
 *     const { appDb } = await import('../../src/lib/db');
 *     …
 *   });
 *   afterAll(async () => {
 *     await database.close();
 *     vi.resetModules();
 *   });
 *
 * Import the application's modules after openAppDatabase() and
 * vi.resetModules(), so they open the database it set up.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type GlobalDbState = typeof globalThis & {
  __SQLITE_CLIENT__?: { close: () => void };
  __DRIZZLE_DB__?: unknown;
  __MIGRATIONS_RAN__?: boolean;
  __ingressiPgExecutor?: unknown;
  __ingressiPgPool?: { end(): Promise<void> };
};

const globalState = globalThis as GlobalDbState;

/** Forgets the SQLite connection src/lib/db/sqlite.ts keeps across module reloads (closing it). */
function resetSqliteState(): void {
  globalState.__SQLITE_CLIENT__?.close();
  delete globalState.__SQLITE_CLIENT__;
  delete globalState.__DRIZZLE_DB__;
  delete globalState.__MIGRATIONS_RAN__;
}

/** Forgets the application's PostgreSQL executor and pool (closing it), so the next import makes new ones. */
async function resetPostgresState(): Promise<void> {
  const pool = globalState.__ingressiPgPool;
  delete globalState.__ingressiPgPool;
  delete globalState.__ingressiPgExecutor;
  await pool?.end();
}

export interface AppDatabase {
  readonly dialect: 'sqlite' | 'postgres';
  /** Closes the application's connections (and on SQLite removes the file). */
  close(): Promise<void>;
}

/**
 * Points the application at a fresh database (see the module comment).
 * `prefix` names the temporary directory of the SQLite file.
 */
export async function openAppDatabase(prefix: string): Promise<AppDatabase> {
  if (process.env.TEST_DB_DIALECT === 'postgres') {
    // createTestDb() empties the worker's database; its first query waits for that.
    const [{ createTestDb }, { settings }] = await Promise.all([
      import('./db'),
      import('../../src/lib/db/schema'),
    ]);
    await createTestDb().$count(settings);
    await resetPostgresState();
    return { dialect: 'postgres', close: resetPostgresState };
  }
  const workDir = mkdtempSync(join(tmpdir(), prefix));
  process.env.DATABASE_URL = `file:${join(workDir, 'app.db')}`;
  resetSqliteState();
  return {
    dialect: 'sqlite',
    close: async () => {
      resetSqliteState();
      rmSync(workDir, { recursive: true, force: true });
      process.env.DATABASE_URL = ':memory:';
    },
  };
}
