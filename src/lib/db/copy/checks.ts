/**
 * The checks the copy (copy.ts) and the verification (verify.ts) share: the
 * schema version on both sides, the source's tables and columns, and the
 * settings of their PostgreSQL sessions.
 */
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type pg from "pg";
import { newestMigrationWhen, PG_MIGRATIONS_FOLDER } from "../pg-startup";
import { CopyRefusedError } from "./errors";
import { isInternalSqliteTable, type SqliteSource } from "./source";
import type { CopyTable } from "./tables";

/** Rows read from SQLite and written to PostgreSQL per statement. */
export const DEFAULT_BATCH_SIZE = 2000;
export const BATCH_SIZE_LIMITS = { min: 1, max: 50_000 } as const;

/**
 * application_name of the copy's PostgreSQL sessions, unlike the
 * application's ("ingressi"), so the copy can tell a running web container
 * from itself.
 */
export const COPY_APPLICATION_NAME = "ingressi-copy";

/**
 * Inside the copy's and the verification's transaction: statements on large
 * tables (an insert batch, a TRUNCATE, a cursor) and the SQLite reads
 * between them may take longer than the application's limits allow.
 */
export const COPY_SESSION_SETTINGS =
  "SET LOCAL statement_timeout = '15min'; SET LOCAL idle_in_transaction_session_timeout = '15min'";

/** The SQLite migrations, next to drizzle-pg/ (docker/web/Dockerfile copies both). */
export const SQLITE_MIGRATIONS_FOLDER = resolvePath(process.cwd(), "drizzle");

function migrationName(folder: string, when: number): string {
  const journal = JSON.parse(readFileSync(resolvePath(folder, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ when: number; tag: string }>;
  };
  const entry = journal.entries.find((candidate) => candidate.when === when);
  return entry ? entry.tag : `a migration from ${new Date(when).toISOString()}`;
}

export interface SourceSchema {
  /** The `when` of the newest migration applied to the SQLite database. */
  readonly newestMigration: number;
  /** Tables in the SQLite file that this version's schema does not have (not copied). */
  readonly unknownTables: readonly string[];
}

/**
 * Refuses a SQLite database that is not at the schema version this
 * version's migrations produce (behind or ahead), and one whose tables or
 * columns differ from the schema (rows would be lost or not fit).
 */
export function readSourceSchema(source: SqliteSource, tables: readonly CopyTable[]): SourceSchema {
  const known = newestMigrationWhen(SQLITE_MIGRATIONS_FOLDER);
  const pgKnown = newestMigrationWhen(PG_MIGRATIONS_FOLDER);
  if (known !== pgKnown) {
    // drizzle/ and drizzle-pg/ come in pairs (tests/unit/db-migration-pairs.test.ts).
    throw new Error("This build's SQLite and PostgreSQL migrations end at different versions; the copy cannot run.");
  }
  const applied = source.newestMigration();
  if (applied === null) {
    throw new CopyRefusedError(`${source.path} is not an Ingressi database: it has no migration history.`);
  }
  if (applied < known) {
    throw new CopyRefusedError(
      `The SQLite database is at an older schema version (its newest migration is ` +
        `${migrationName(SQLITE_MIGRATIONS_FOLDER, applied)}, this version's is ${migrationName(SQLITE_MIGRATIONS_FOLDER, known)}). ` +
        "Start this version of Ingressi on the SQLite database once so that it migrates it, stop it, then run the copy again."
    );
  }
  if (applied > known) {
    throw new CopyRefusedError(
      `The SQLite database was migrated by a newer version of Ingressi (its newest migration is from ` +
        `${new Date(applied).toISOString()}, this version knows migrations up to ${new Date(known).toISOString()}). ` +
        "Run the copy with the version that migrated it, or a newer one."
    );
  }

  const present = new Set(source.tableNames());
  const missing = tables.filter((table) => !present.has(table.name)).map((table) => table.name);
  if (missing.length > 0) {
    throw new CopyRefusedError(`The SQLite database has no table ${missing.join(", ")}, although its schema version should.`);
  }
  for (const table of tables) {
    const actual = source.columnNames(table.name);
    const expected = table.columns.map((column) => column.name);
    const extra = actual.filter((name) => !expected.includes(name));
    const absent = expected.filter((name) => !actual.includes(name));
    if (extra.length > 0 || absent.length > 0) {
      throw new CopyRefusedError(
        `The SQLite table ${table.name} does not have the columns of this version's schema` +
          `${extra.length > 0 ? `; not in the schema: ${extra.join(", ")}` : ""}` +
          `${absent.length > 0 ? `; missing: ${absent.join(", ")}` : ""}. It was changed outside Ingressi; the copy would lose data.`
      );
    }
  }
  const schemaTables = new Set(tables.map((table) => table.name));
  const unknownTables = [...present].filter((name) => !schemaTables.has(name) && !isInternalSqliteTable(name)).sort();
  return { newestMigration: applied, unknownTables };
}

/** The `when` of the newest migration the PostgreSQL database records, or null when it was never migrated. */
export async function targetSchemaVersion(connection: Pick<pg.ClientBase, "query">): Promise<number | null> {
  const { rows: exists } = await connection.query<{ present: boolean }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present"
  );
  if (!exists[0]?.present) return null;
  const { rows } = await connection.query<{ newest: string | number | null }>(
    "SELECT max(created_at) AS newest FROM drizzle.__drizzle_migrations"
  );
  const newest = rows[0]?.newest;
  return newest === null || newest === undefined ? null : Number(newest);
}

/** Refuses databases at different schema versions. */
export function assertSameSchemaVersion(source: number, target: number | null): void {
  if (target === source) return;
  throw new CopyRefusedError(
    target === null
      ? "The PostgreSQL database has not been migrated by Ingressi."
      : `The PostgreSQL database is at a different schema version (its newest migration is from ` +
          `${new Date(target).toISOString()}, the SQLite database's from ${new Date(source).toISOString()}).`
  );
}

/**
 * Runs `fn` in a transaction on `connection` that `begin` opens, and rolls
 * it back unless `commit` is set and `fn` succeeded. A rollback that fails
 * marks the connection broken (returned so the caller does not reuse it).
 */
export async function inTransaction<T>(
  connection: pg.PoolClient,
  begin: string,
  fn: () => Promise<T>,
  { commit }: { commit: boolean }
): Promise<T> {
  await connection.query(begin);
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    try {
      await connection.query("ROLLBACK");
    } catch {
      // The connection is closed by the caller (released as broken).
    }
    throw error;
  }
  const end = await connection.query(commit ? "COMMIT" : "ROLLBACK");
  // A transaction in which a statement failed ends in ROLLBACK even when asked to commit.
  if (commit && end.command === "ROLLBACK") throw new Error("The PostgreSQL transaction was rolled back instead of committed.");
  return result;
}
