/**
 * Checks that a PostgreSQL database holds the same rows as the SQLite
 * database it was copied from (copy.ts runs it before committing; the CLI
 * runs it alone with --verify-only).
 *
 * Per table, both sides are reduced to a row count and a checksum computed
 * the same way (tables.ts TableDigest): every value normalised to text
 * (integers as decimal text, booleans as "true"/"false", NULL as null; on
 * PostgreSQL the column cast to text, so 64-bit integers stay exact), each
 * row hashed, the hashes summed. Any difference is reported per table.
 */
import type pg from "pg";
import { CopyRefusedError } from "./errors";
import { SqliteSource } from "./source";
import {
  copyTables,
  postgresToken,
  quoteIdentifier,
  sqliteToken,
  TableDigest,
  type CopyTable,
} from "./tables";
import { postgresCompatibilityProblems, readPostgresDatabaseFacts } from "../pg-startup";
import { createPostgresPool, watchHeldConnection } from "../postgres";
import {
  assertSameSchemaVersion,
  COPY_APPLICATION_NAME,
  COPY_SESSION_SETTINGS,
  DEFAULT_BATCH_SIZE,
  inTransaction,
  readSourceSchema,
  targetSchemaVersion,
} from "./checks";

/** A connection the checksums read through (one transaction). */
export type Queryable = Pick<pg.ClientBase, "query">;

export interface TableComparison {
  readonly table: string;
  readonly sourceRows: number;
  readonly targetRows: number;
  readonly sourceChecksum: string;
  readonly targetChecksum: string;
  readonly matches: boolean;
}

export interface VerifyReport {
  /** Whether every table has the same rows on both sides. */
  readonly ok: boolean;
  readonly tables: readonly TableComparison[];
}

/** The copy's verification found differences; the copy was rolled back. */
export class CopyVerificationError extends Error {
  constructor(readonly report: VerifyReport) {
    const differing = report.tables.filter((table) => !table.matches).map((table) => table.table);
    super(
      `The copy does not match the SQLite database in ${differing.length} ` +
        `${differing.length === 1 ? "table" : "tables"} (${differing.join(", ")}); it was rolled back.`
    );
    this.name = "CopyVerificationError";
  }
}

/** The count and checksum of `table` in the SQLite database. */
export function checksumSqliteTable(source: SqliteSource, table: CopyTable, batchSize = DEFAULT_BATCH_SIZE): TableDigest {
  const digest = new TableDigest();
  for (const batch of source.batches(table, batchSize)) {
    for (const row of batch) digest.add(table.columns.map((column, index) => sqliteToken(column.kind, row.values[index])));
  }
  return digest;
}

const CURSOR = "ingressi_copy_verify";

/**
 * The count and checksum of `table` in PostgreSQL, read through a cursor
 * `batchSize` rows at a time. `connection` must be inside a transaction.
 */
export async function checksumPostgresTable(
  connection: Queryable,
  table: CopyTable,
  batchSize = DEFAULT_BATCH_SIZE
): Promise<TableDigest> {
  const digest = new TableDigest();
  const columns = table.columns.map((column) => `${quoteIdentifier(column.name)}::text`);
  await connection.query(`DECLARE ${CURSOR} NO SCROLL CURSOR FOR SELECT ${columns.join(", ")} FROM ${quoteIdentifier(table.name)}`);
  for (;;) {
    const { rows } = await connection.query<unknown[]>({ text: `FETCH FORWARD ${batchSize} FROM ${CURSOR}`, rowMode: "array" });
    for (const row of rows) digest.add(row.map((value) => postgresToken(value as string | null)));
    if (rows.length < batchSize) break;
  }
  // After a failure the transaction is rolled back, which closes the cursor.
  await connection.query(`CLOSE ${CURSOR}`);
  return digest;
}

/** Compares every table of `tables` between the two databases. */
export async function compareTables(
  source: SqliteSource,
  connection: Queryable,
  tables: readonly CopyTable[],
  batchSize = DEFAULT_BATCH_SIZE
): Promise<VerifyReport> {
  const comparisons: TableComparison[] = [];
  for (const table of tables) {
    const expected = checksumSqliteTable(source, table, batchSize);
    const actual = await checksumPostgresTable(connection, table, batchSize);
    comparisons.push({
      table: table.name,
      sourceRows: expected.rows,
      targetRows: actual.rows,
      sourceChecksum: expected.checksum,
      targetChecksum: actual.checksum,
      matches: expected.rows === actual.rows && expected.checksum === actual.checksum,
    });
  }
  return { ok: comparisons.every((comparison) => comparison.matches), tables: comparisons };
}

/** The report as lines of text: one per table, then the outcome. */
export function formatVerifyReport(report: VerifyReport): string[] {
  const width = Math.max(5, ...report.tables.map((table) => table.table.length));
  const lines = report.tables.map((table) => {
    const name = table.table.padEnd(width);
    if (table.matches) return `  ${name}  same       ${table.sourceRows} rows, checksum ${table.sourceChecksum.slice(0, 16)}`;
    const rows =
      table.sourceRows === table.targetRows
        ? `${table.sourceRows} rows each`
        : `${table.sourceRows} rows in SQLite, ${table.targetRows} in PostgreSQL`;
    return `  ${name}  DIFFERENT  ${rows}, checksums ${table.sourceChecksum.slice(0, 16)} and ${table.targetChecksum.slice(0, 16)}`;
  });
  const differing = report.tables.filter((table) => !table.matches).length;
  lines.push(
    report.ok
      ? `Every table (${report.tables.length}) has the same rows in both databases.`
      : `${differing} of ${report.tables.length} tables differ.`
  );
  return lines;
}

export interface VerifyOptions {
  /** The SQLite database file. */
  sourcePath: string;
  /** How to connect to the PostgreSQL database (readPostgresConfig()). */
  target: pg.PoolConfig;
  batchSize?: number;
  log?: (line: string) => void;
}

/**
 * Compares the SQLite database with the PostgreSQL one without changing
 * either (--verify-only): both must be at the same schema version, and the
 * PostgreSQL side is read in one read-only snapshot.
 */
export async function verifySqliteAgainstPostgres(options: VerifyOptions): Promise<VerifyReport> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const tables = copyTables();
  const source = SqliteSource.open(options.sourcePath);
  try {
    const sourceSchema = readSourceSchema(source, tables);
    for (const name of sourceSchema.unknownTables) {
      options.log?.(`Not compared: the SQLite table ${name} is not part of this version's schema.`);
    }
    const pool = createPostgresPool({ ...options.target, max: 1, application_name: COPY_APPLICATION_NAME });
    try {
      const connection = await pool.connect();
      const unwatch = watchHeldConnection(connection, "the verification");
      let broken: Error | undefined;
      try {
        const problems = postgresCompatibilityProblems(await readPostgresDatabaseFacts(connection));
        if (problems.length > 0) throw new CopyRefusedError(`The PostgreSQL database cannot be used: ${problems.join("; ")}.`);
        return await inTransaction(
          connection,
          "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
          async () => {
            await connection.query(COPY_SESSION_SETTINGS);
            assertSameSchemaVersion(sourceSchema.newestMigration, await targetSchemaVersion(connection));
            return await compareTables(source, connection, tables, batchSize);
          },
          { commit: false }
        );
      } catch (error) {
        if (!(error instanceof CopyRefusedError)) broken = error instanceof Error ? error : new Error(String(error));
        throw error;
      } finally {
        unwatch();
        connection.release(broken);
      }
    } finally {
      await pool.end();
    }
  } finally {
    source.close();
  }
}
