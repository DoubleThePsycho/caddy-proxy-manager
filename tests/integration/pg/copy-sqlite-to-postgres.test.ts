/**
 * The SQLite → PostgreSQL copy (src/lib/db/copy/) against a real server: a
 * SQLite database with rows in every table (tests/helpers/copy-fixture.ts:
 * unicode, NULLs, the int4 and int8 limits, booleans, JSON) is copied into a
 * new PostgreSQL database, which the copy migrates, and the application
 * reads the same rows from both. The refusals: a SQLite file in use, behind
 * or ahead of this version's schema, secrets SESSION_SECRET does not
 * decrypt, a target that holds rows or that Ingressi is connected to, values
 * PostgreSQL cannot hold, and a copy that does not match (rolled back).
 * Each test creates its own databases; skipped without TEST_DATABASE_URL.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { copySqliteToPostgres } from '../../../src/lib/db/copy/copy';
import { CopyRefusedError } from '../../../src/lib/db/copy/errors';
import { copyTables, quoteIdentifier } from '../../../src/lib/db/copy/tables';
import { CopyVerificationError, verifySqliteAgainstPostgres } from '../../../src/lib/db/copy/verify';
import { createPostgresExecutor, createSqliteExecutor } from '../../../src/lib/db/executor';
import { preparePostgresDatabase } from '../../../src/lib/db/pg-startup';
import { createPostgresPool, readPostgresConfig } from '../../../src/lib/db/postgres';
import { encryptSecret } from '../../../src/lib/secret';
import { encryptUnderOtherSecret } from '../../helpers/encrypt-under-other-secret';
import { INT8_MAX, populateEveryTable } from '../../helpers/copy-fixture';
import { createPgTestDatabase, TEST_DATABASE_URL } from '../../helpers/pg-database';
import { databaseUrl, withTestServer } from '../../helpers/pg-test-db';

const cleanup: Array<() => Promise<void>> = [];
const workDir = mkdtempSync(join(tmpdir(), 'ingressi-copy-'));

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  for (const step of cleanup.reverse()) await step().catch(() => undefined);
  rmSync(workDir, { recursive: true, force: true });
});

let fixtures = 0;

/** A migrated SQLite database with rows in every table; `change` runs on it afterwards. */
function sqliteFixture(options: { encryptedSecret?: string; change?: (client: Database.Database) => void } = {}): string {
  const path = join(workDir, `source-${++fixtures}.db`);
  const client = new Database(path);
  try {
    migrate(drizzle(client), { migrationsFolder: resolve(process.cwd(), 'drizzle') });
    populateEveryTable(client, { encryptedSecret: options.encryptedSecret ?? encryptSecret('client-secret-value') });
    options.change?.(client);
  } finally {
    client.close();
  }
  return path;
}

type Target = { name: string; url: string; client: pg.Client; config: pg.PoolConfig };

/** A new, empty PostgreSQL database (UTF8, C collation), not migrated. */
async function targetDatabase(label: string): Promise<Target> {
  const created = await createPgTestDatabase(label);
  cleanup.push(() => created.drop());
  const url = databaseUrl(TEST_DATABASE_URL!, created.name);
  return { name: created.name, url, client: created.client, config: readPostgresConfig({ DATABASE_URL: url }) };
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(() => null, (error: unknown) => error);
  if (!(outcome instanceof Error)) throw new Error('expected the copy to be refused');
  return outcome;
}

/** Rows of every copied table in the target (none after a rolled-back copy). */
async function targetRows(target: Target): Promise<number> {
  const { rows } = await target.client.query<{ total: string }>(
    `SELECT ${copyTables().map((table) => `(SELECT count(*) FROM ${quoteIdentifier(table.name)})`).join(' + ')} AS total`
  );
  return Number(rows[0].total);
}

async function migrated(target: Target): Promise<boolean> {
  const { rows } = await target.client.query<{ present: boolean }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present"
  );
  return rows[0].present;
}

/** Rows in a stable order (the application returns them in no particular one). */
function sorted(rows: readonly unknown[]): unknown[] {
  return [...rows].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
}


describe.skipIf(!TEST_DATABASE_URL)('copying SQLite into PostgreSQL', () => {
  it('copies every table exactly, and the application reads the same rows from both', async () => {
    const source = sqliteFixture();
    const target = await targetDatabase('copy_full');
    const lines: string[] = [];
    const warnings: string[] = [];
    const result = await copySqliteToPostgres({
      sourcePath: source,
      target: target.config,
      batchSize: 2,
      log: (line) => lines.push(line),
      warn: (line) => warnings.push(line),
    });

    expect(warnings).toEqual([]);
    expect(result.verify.ok).toBe(true);
    expect(result.verify.tables.every((table) => table.sourceRows === table.targetRows && table.sourceRows > 0)).toBe(true);
    expect(result.secretsChecked).toBe(1);
    expect(result.replaced).toEqual([]);
    expect(result.notCopied).toEqual([]);
    expect(result.tables.find((entry) => entry.table === 'users')?.rows).toBe(4);
    expect(lines).toContain('users: 4 rows copied');

    // The copy migrated the database, which holds exactly the copied tables.
    const { rows: tables } = await target.client.query<{ name: string }>(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    );
    expect(tables.map((row) => row.name)).toEqual(copyTables().map((table) => table.name).sort());

    // The application reads the same rows on both dialects.
    const sqliteClient = new Database(source, { readonly: true });
    const pool = createPostgresPool(target.config);
    try {
      const sqliteDb = createSqliteExecutor(sqliteClient).db;
      const pgDb = createPostgresExecutor(pool).db;
      for (const table of copyTables()) {
        const fromSqlite = await sqliteDb.select().from(table.sqliteTable as any);
        const fromPg = await pgDb.select().from(table.pgTable as any);
        expect({ table: table.name, rows: sorted(fromPg) }).toEqual({ table: table.name, rows: sorted(fromSqlite) });
      }

      // 64-bit integers are exact, beyond what a JavaScript number holds.
      for (const table of copyTables()) {
        for (const column of table.columns.filter((candidate) => candidate.kind === 'int8')) {
          const expected = (
            sqliteClient
              .prepare(`SELECT ${quoteIdentifier(column.name)} AS value FROM ${quoteIdentifier(table.name)}`)
              .safeIntegers(true)
              .all() as Array<{ value: bigint | null }>
          ).map((row) => (row.value === null ? null : row.value.toString()));
          const { rows } = await target.client.query<{ value: string | null }>(
            `SELECT ${quoteIdentifier(column.name)}::text AS value FROM ${quoteIdentifier(table.name)}`
          );
          expect(sorted(rows.map((row) => row.value))).toEqual(sorted(expected));
          // The fixture fills every int8 column with 2^63 - 1 except identity
          // keys, which number their rows.
          if (column.name !== table.identity) expect(expected).toContain(INT8_MAX.toString());
        }
      }
    } finally {
      sqliteClient.close();
      await pool.end();
    }

    // --verify-only agrees.
    expect((await verifySqliteAgainstPostgres({ sourcePath: source, target: target.config })).ok).toBe(true);

    // A user disabled before disabledAt existed keeps it empty: the insert
    // trigger did not run during the copy, and runs again afterwards.
    const { rows: disabled } = await target.client.query('SELECT "status", "disabledAt" FROM "users" WHERE "id" = 4');
    expect(disabled).toEqual([{ status: 'disabled', disabledAt: null }]);
    const { rows: inserted } = await target.client.query<{ id: number; disabledAt: string | null }>(
      `INSERT INTO "users" ("email", "status", "createdAt", "updatedAt")
       VALUES ('new@example.com', 'disabled', '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z')
       RETURNING "id", "disabledAt"`
    );
    expect(inserted[0].id).toBe(5);
    expect(inserted[0].disabledAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const { rows: triggers } = await target.client.query<{ enabled: string }>(
      "SELECT tgenabled AS enabled FROM pg_trigger WHERE tgrelid = 'users'::regclass AND NOT tgisinternal"
    );
    expect(triggers.length).toBeGreaterThan(0);
    expect(triggers.every((trigger) => trigger.enabled === 'O')).toBe(true);

    // Identities continue after the highest id SQLite handed out, deleted rows included.
    const { rows: next } = await target.client.query<{ id: string }>(
      `SELECT nextval(pg_get_serial_sequence('"instances"', 'id')) AS id`
    );
    expect(Number(next[0].id)).toBe(51);

    // --verify-only finds the changes made since (a user and a host).
    await target.client.query(`UPDATE "proxy_hosts" SET "name" = 'changed' WHERE "id" = 1`);
    const report = await verifySqliteAgainstPostgres({ sourcePath: source, target: target.config });
    expect(report.ok).toBe(false);
    expect(report.tables.filter((table) => !table.matches).map((table) => table.table)).toEqual(['proxy_hosts', 'users']);
  }, 120_000);

  it('refuses a target that holds rows, and with replace empties it first', async () => {
    const source = sqliteFixture();
    const target = await targetDatabase('copy_replace');
    await copySqliteToPostgres({ sourcePath: source, target: target.config });
    await target.client.query(`INSERT INTO "settings" ("key", "value", "updatedAt") VALUES ('extra', '1', '2026-10-04T00:00:00.000Z')`);

    const error = await refusal(copySqliteToPostgres({ sourcePath: source, target: target.config }));
    expect(error).toBeInstanceOf(CopyRefusedError);
    expect(error.message).toMatch(/already holds Ingressi data \(rows per table: .*settings 4, .*users 4/);
    expect(error.message).toMatch(/--replace/);

    const warnings: string[] = [];
    const result = await copySqliteToPostgres({ sourcePath: source, target: target.config, replace: true, warn: (line) => warnings.push(line) });
    expect(result.verify.ok).toBe(true);
    expect(result.replaced).toContainEqual({ table: 'settings', rows: 4 });
    expect(warnings.join('\n')).toMatch(/^--replace: deleting \d+ rows in \d+ tables of the PostgreSQL database before copying/);
    const { rows } = await target.client.query(`SELECT 1 FROM "settings" WHERE "key" = 'extra'`);
    expect(rows).toEqual([]);
  }, 120_000);

  it('refuses a target Ingressi is connected to', async () => {
    const source = sqliteFixture();
    const target = await targetDatabase('copy_connected');
    const web = new pg.Client({ connectionString: target.url, application_name: 'ingressi' });
    await web.connect();
    try {
      const error = await refusal(copySqliteToPostgres({ sourcePath: source, target: target.config }));
      expect(error).toBeInstanceOf(CopyRefusedError);
      expect(error.message).toMatch(/Ingressi is connected to the PostgreSQL database \(1 session\)/);
    } finally {
      await web.end();
    }
    expect(await targetRows(target)).toBe(0);
  }, 60_000);

  it('refuses a SQLite database behind or ahead of this version, before touching the target', async () => {
    const behind = sqliteFixture({
      change: (client) => client.exec('DELETE FROM "__drizzle_migrations" WHERE "created_at" = (SELECT max("created_at") FROM "__drizzle_migrations")'),
    });
    const ahead = sqliteFixture({
      change: (client) => client.prepare('INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)').run('newer', 9_999_999_999_999),
    });
    const target = await targetDatabase('copy_version');

    const older = await refusal(copySqliteToPostgres({ sourcePath: behind, target: target.config }));
    expect(older).toBeInstanceOf(CopyRefusedError);
    expect(older.message).toMatch(/older schema version .*Start this version of Ingressi on the SQLite database once/);
    const newer = await refusal(copySqliteToPostgres({ sourcePath: ahead, target: target.config }));
    expect(newer.message).toMatch(/migrated by a newer version of Ingressi/);
    expect(await migrated(target)).toBe(false);
  }, 60_000);

  it('refuses stored secrets that SESSION_SECRET does not decrypt, before touching the target', async () => {
    const source = sqliteFixture({ encryptedSecret: encryptUnderOtherSecret('client-secret-value') });
    const target = await targetDatabase('copy_secret');
    const error = await refusal(copySqliteToPostgres({ sourcePath: source, target: target.config }));
    expect(error).toBeInstanceOf(CopyRefusedError);
    expect(error.message).toMatch(/SESSION_SECRET does not decrypt the secrets stored in the SQLite database \(oauth_providers\.clientSecret\)/);
    expect(error.message).not.toContain('enc:v1:');

    const readable = sqliteFixture();
    vi.stubEnv('SESSION_SECRET', '');
    const unset = await refusal(copySqliteToPostgres({ sourcePath: readable, target: target.config }));
    expect(unset.message).toMatch(/^SESSION_SECRET is not set/);
    expect(await migrated(target)).toBe(false);
  }, 60_000);

  it('refuses a SQLite database another process has open, or that is not one', async () => {
    const source = sqliteFixture();
    const target = await targetDatabase('copy_in_use');
    writeFileSync(`${source}-wal`, '');
    const wal = await refusal(copySqliteToPostgres({ sourcePath: source, target: target.config }));
    expect(wal.message).toMatch(/open in another process, or was not closed cleanly/);
    rmSync(`${source}-wal`);
    writeFileSync(`${source}-journal`, 'unfinished');
    const journal = await refusal(copySqliteToPostgres({ sourcePath: source, target: target.config }));
    expect(journal.message).toMatch(/write to the SQLite database is in progress, or did not finish/);

    const missing = await refusal(copySqliteToPostgres({ sourcePath: join(workDir, 'missing.db'), target: target.config }));
    expect(missing.message).toMatch(/There is no SQLite database at/);
    const notSqlite = join(workDir, 'not-sqlite.db');
    writeFileSync(notSqlite, 'this is not a database, it is long enough to have a header');
    const garbage = await refusal(copySqliteToPostgres({ sourcePath: notSqlite, target: target.config }));
    expect(garbage).toBeInstanceOf(CopyRefusedError);
    expect(garbage.message).toMatch(/Cannot (open|read) the SQLite database/);
    expect(await migrated(target)).toBe(false);
  }, 60_000);

  it('refuses a value PostgreSQL cannot hold, and rolls back what it copied', async () => {
    const source = sqliteFixture({
      change: (client) => client.exec('UPDATE "proxy_hosts" SET "certificateId" = 2147483648 WHERE "id" = 3'),
    });
    const target = await targetDatabase('copy_range');
    const error = await refusal(copySqliteToPostgres({ sourcePath: source, target: target.config }));
    expect(error).toBeInstanceOf(CopyRefusedError);
    expect(error.message).toMatch(/^proxy_hosts\.certificateId of the row with id 3 holds 2147483648, outside the range of a PostgreSQL integer/);
    expect(await migrated(target)).toBe(true);
    expect(await targetRows(target)).toBe(0);
  }, 60_000);

  it('rolls everything back when the copy does not match the source', async () => {
    const source = sqliteFixture();
    const target = await targetDatabase('copy_mismatch');
    const pool = createPostgresPool(target.config);
    try {
      await preparePostgresDatabase(pool);
    } finally {
      await pool.end();
    }
    // Something in the target that changes rows as they arrive.
    await target.client.query(`CREATE RULE "test_drop_settings" AS ON INSERT TO "settings" DO ALSO DELETE FROM "settings" WHERE "key" = NEW."key"`);
    const error = await refusal(copySqliteToPostgres({ sourcePath: source, target: target.config }));
    expect(error).toBeInstanceOf(CopyVerificationError);
    const report = (error as CopyVerificationError).report;
    expect(report.tables.filter((table) => !table.matches)).toEqual([
      expect.objectContaining({ table: 'settings', sourceRows: 3, targetRows: 0 }),
    ]);
    expect(error.message).toMatch(/does not match the SQLite database in 1 table \(settings\); it was rolled back/);
    expect(await targetRows(target)).toBe(0);
  }, 60_000);

  it('refuses a database without the C collation, as start-up does', async (context) => {
    const name = `ingressi_test_copy_locale_${Date.now().toString(36)}`;
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
    const error = await refusal(
      copySqliteToPostgres({ sourcePath: sqliteFixture(), target: readPostgresConfig({ DATABASE_URL: databaseUrl(TEST_DATABASE_URL!, name) }) })
    );
    expect(error).toBeInstanceOf(CopyRefusedError);
    expect(error.message).toMatch(/C collation and character classification/);
  }, 60_000);

  it('verifies only a database at the same schema version', async () => {
    const target = await targetDatabase('copy_verify_unmigrated');
    const error = await refusal(verifySqliteAgainstPostgres({ sourcePath: sqliteFixture(), target: target.config }));
    expect(error).toBeInstanceOf(CopyRefusedError);
    expect(error.message).toMatch(/has not been migrated by Ingressi/);
  }, 60_000);
});
