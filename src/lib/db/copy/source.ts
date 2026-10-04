/**
 * The SQLite database the copy reads (copy.ts, verify.ts): opened read-only,
 * with integers as bigint so 64-bit values stay exact, and read in one read
 * transaction from the first statement to close(). That is a consistent
 * snapshot, and on a database in rollback-journal mode (the default) the
 * shared lock it holds keeps any writer from committing until the copy ends.
 *
 * Nothing here imports the application's database modules (src/lib/db.ts,
 * executor.ts, sqlite.ts): opening those would open, migrate and repair the
 * file DATABASE_URL names, which may be this one.
 */
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { CopyRefusedError } from "./errors";
import { quoteIdentifier, type CopyTable, type SqliteValue } from "./tables";

/** Drizzle's record of the migrations it applied, in the SQLite database. */
const MIGRATIONS_TABLE = "__drizzle_migrations";

/** Tables of SQLite itself and of Drizzle's migrator, which the schema does not describe. */
export function isInternalSqliteTable(name: string): boolean {
  return name.startsWith("sqlite_") || name === MIGRATIONS_TABLE;
}

const STOP_WEB =
  "Stop the web container (docker compose stop web) and run the copy again. If it is already stopped, " +
  "start it and stop it once, so SQLite";

/**
 * Refuses a database another process has open, as far as the files show:
 * a write-ahead log exists while a connection has the database open in WAL
 * mode (or after a crash), and a rollback journal with content while a
 * write is in progress (or after a crash). A database in rollback-journal
 * mode that is merely open shows nothing; the documentation says to stop
 * the web container first.
 */
export function assertSqliteNotInUse(path: string): void {
  if (existsSync(`${path}-wal`)) {
    throw new CopyRefusedError(
      `The SQLite database is open in another process, or was not closed cleanly (${path}-wal exists). ` +
        `${STOP_WEB} folds its write-ahead log back into the database.`
    );
  }
  const journal = `${path}-journal`;
  if (existsSync(journal) && statSync(journal).size > 0) {
    throw new CopyRefusedError(
      `A write to the SQLite database is in progress, or did not finish (${journal} exists). ` +
        `${STOP_WEB} rolls the unfinished write back.`
    );
  }
}

type Statement = {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | null | undefined;
};

/** One row as read: SQLite's rowid and the values in the order of the table's columns. */
export interface SourceRow {
  readonly rowid: bigint;
  readonly values: readonly SqliteValue[];
}

export class SqliteSource {
  private readonly statements = new Map<string, Statement>();

  private constructor(
    readonly path: string,
    private readonly database: Database
  ) {}

  /** Opens `path` read-only (see the module comment). Throws CopyRefusedError. */
  static open(path: string): SqliteSource {
    if (!existsSync(path)) throw new CopyRefusedError(`There is no SQLite database at ${path}.`);
    assertSqliteNotInUse(path);
    let database: Database;
    try {
      database = new Database(path, { readonly: true, safeIntegers: true });
    } catch (error) {
      throw new CopyRefusedError(`Cannot open the SQLite database ${path}: ${(error as Error).message}`);
    }
    // better-sqlite3 (tests) takes the option as a call.
    (database as unknown as { defaultSafeIntegers?: (on: boolean) => void }).defaultSafeIntegers?.(true);
    const source = new SqliteSource(path, database);
    try {
      database.exec("BEGIN");
      // The first read takes the shared lock the transaction then holds.
      source.tableNames();
    } catch (error) {
      source.close();
      throw new CopyRefusedError(`Cannot read the SQLite database ${path}: ${(error as Error).message}`);
    }
    return source;
  }

  private statement(sql: string): Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.database.prepare(sql) as unknown as Statement;
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** The tables in the file, SQLite's and Drizzle's own included. */
  tableNames(): string[] {
    return this.statement("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => String(row.name));
  }

  /** The columns of `table` in the file. */
  columnNames(table: string): string[] {
    return this.statement("SELECT name FROM pragma_table_info(?)")
      .all(table)
      .map((row) => String(row.name));
  }

  /** The `when` of the newest migration applied to the file, or null when it has no migration history. */
  newestMigration(): number | null {
    if (!this.tableNames().includes(MIGRATIONS_TABLE)) return null;
    const row = this.statement(`SELECT max(created_at) AS newest FROM ${quoteIdentifier(MIGRATIONS_TABLE)}`).get();
    const newest = row?.newest;
    return newest === null || newest === undefined ? null : Number(newest);
  }

  /** The highest id AUTOINCREMENT handed out for `table` (sqlite_sequence), which deleted rows may exceed. */
  sequence(table: string): bigint | null {
    if (!this.tableNames().includes("sqlite_sequence")) return null;
    const row = this.statement("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table);
    const seq = row?.seq;
    return typeof seq === "bigint" ? seq : typeof seq === "number" ? BigInt(seq) : null;
  }

  /** The number of rows of `table`. */
  count(table: string): number {
    const row = this.statement(`SELECT count(*) AS count FROM ${quoteIdentifier(table)}`).get();
    return Number(row?.count ?? 0);
  }

  /**
   * The rows of `table`, `batchSize` at a time, in rowid order (a rowid
   * range per batch, so a large table is never read whole).
   */
  *batches(table: CopyTable, batchSize: number): Generator<SourceRow[]> {
    const select = `SELECT rowid AS "__copy_rowid", ${table.columns.map((column) => quoteIdentifier(column.name)).join(", ")} ` +
      `FROM ${quoteIdentifier(table.name)}`;
    const firstBatch = this.statement(`${select} ORDER BY rowid LIMIT ?`);
    const nextBatch = this.statement(`${select} WHERE rowid > ? ORDER BY rowid LIMIT ?`);
    let after: bigint | null = null;
    for (;;) {
      // Annotated: `after` is narrowed from `rows`, which TypeScript 6 (next build) cannot infer on its own.
      const rows: Record<string, unknown>[] = after === null ? firstBatch.all(batchSize) : nextBatch.all(after, batchSize);
      if (rows.length === 0) return;
      yield rows.map((row) => ({
        rowid: BigInt(row.__copy_rowid as bigint | number),
        values: table.columns.map((column) => row[column.name] as SqliteValue),
      }));
      after = BigInt(rows[rows.length - 1].__copy_rowid as bigint | number);
      if (rows.length < batchSize) return;
    }
  }

  /**
   * One value starting with `prefix` from each text column of `tables` that
   * holds one (the encrypted secrets, to check SESSION_SECRET against).
   */
  textSamples(tables: readonly CopyTable[], prefix: string): Array<{ table: string; column: string; value: string }> {
    const samples: Array<{ table: string; column: string; value: string }> = [];
    for (const table of tables) {
      for (const column of table.columns) {
        if (column.kind !== "text") continue;
        const name = quoteIdentifier(column.name);
        const row = this.statement(
          `SELECT ${name} AS value FROM ${quoteIdentifier(table.name)} WHERE substr(${name}, 1, ?) = ? LIMIT 1`
        ).get(prefix.length, prefix);
        if (typeof row?.value === "string") samples.push({ table: table.name, column: column.name, value: row.value });
      }
    }
    return samples;
  }

  /** Ends the read transaction and closes the file. */
  close(): void {
    try {
      this.database.exec("ROLLBACK");
    } catch {
      // No transaction open (opening failed half-way).
    }
    this.statements.clear();
    this.database.close();
  }
}
