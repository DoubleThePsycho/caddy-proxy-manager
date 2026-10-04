/**
 * Copies an Ingressi SQLite database into PostgreSQL: the one supported way
 * to move an install (D11; there is no way back except the SQLite backup).
 * documentation/postgresql.md describes the procedure; the CLI is
 * scripts/db/copy-sqlite-to-postgres.ts.
 *
 * Before anything is written it refuses
 * - a SQLite file another process has open, as far as its files show
 *   (source.ts), or that is not at the schema version this version's
 *   migrations produce, behind or ahead (checks.ts);
 * - stored secrets that SESSION_SECRET does not decrypt: they are copied
 *   encrypted, so PostgreSQL needs the same secret;
 * - a PostgreSQL server or database start-up would refuse (version 16 or
 *   later, UTF8 with the C collation and character classification, not
 *   migrated by a newer version: pg-startup.ts), which it then migrates as
 *   start-up does.
 *
 * Then, in one transaction holding the migration and write advisory locks
 * (so no Ingressi process migrates or writes meanwhile), it refuses a target
 * that an Ingressi process is connected to or that holds rows (unless
 * `replace`, which empties it first), copies every table of the schema
 * (tables.ts) in batches with explicit ids and values converted to the
 * PostgreSQL columns' types, moves each identity past the highest id SQLite
 * handed out, and compares both databases table by table (verify.ts). Any
 * refusal, error or difference rolls everything back.
 *
 * Rows older releases left behind (src/lib/models/orphaned-rows.ts) are
 * copied as they are: the target's start-up removes them on its first start,
 * as it does on SQLite.
 */
import type pg from "pg";
import { decryptSecret, ENCRYPTED_SECRET_PREFIX } from "../../secret";
import { DatabaseStartupError, preparePostgresDatabase } from "../pg-startup";
import {
  ADVISORY_LOCK_NAMESPACE,
  APPLICATION_NAME,
  createPostgresPool,
  MIGRATE_LOCK_ID,
  watchHeldConnection,
  WRITE_LOCK_ID,
} from "../postgres";
import {
  assertSameSchemaVersion,
  COPY_APPLICATION_NAME,
  COPY_SESSION_SETTINGS,
  DEFAULT_BATCH_SIZE,
  inTransaction,
  readSourceSchema,
  targetSchemaVersion,
} from "./checks";
import { CopyRefusedError } from "./errors";
import { SqliteSource, type SourceRow } from "./source";
import {
  copyTables,
  PG_TYPE_OF_KIND,
  quoteIdentifier,
  toPostgresValue,
  UnsupportedValueError,
  type CopyTable,
  type PgValue,
} from "./tables";
import { compareTables, CopyVerificationError, type VerifyReport } from "./verify";

export interface CopyOptions {
  /** The SQLite database file, opened read-only. */
  sourcePath: string;
  /** How to connect to the PostgreSQL database (readPostgresConfig()). */
  target: pg.PoolConfig;
  /** Empty the target's Ingressi tables first instead of refusing a target that holds rows. */
  replace?: boolean;
  /** Rows per statement (DEFAULT_BATCH_SIZE). */
  batchSize?: number;
  /** Progress. */
  log?: (line: string) => void;
  /** What the person running the copy must not miss (--replace deleting rows, values that do not decrypt). */
  warn?: (line: string) => void;
}

export interface TableCount {
  readonly table: string;
  readonly rows: number;
}

export interface CopyResult {
  /** Rows copied, per table. */
  readonly tables: readonly TableCount[];
  readonly rows: number;
  /** Rows `replace` deleted from the target, per table that held any. */
  readonly replaced: readonly TableCount[];
  /** SQLite tables that are not part of this version's schema, not copied. */
  readonly notCopied: readonly string[];
  /** Encrypted values checked against SESSION_SECRET (one per column that holds any). */
  readonly secretsChecked: number;
  readonly verify: VerifyReport;
  readonly durationMs: number;
}

/** Takes the locks start-up's migration and every writing transaction take (postgres.ts), in that order. */
const BEGIN_COPY =
  `BEGIN; SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_NAMESPACE}, ${MIGRATE_LOCK_ID}); ` +
  `SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_NAMESPACE}, ${WRITE_LOCK_ID})`;

/** The SQLSTATE of insufficient_privilege. */
const INSUFFICIENT_PRIVILEGE = "42501";

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Refuses encrypted values SESSION_SECRET does not decrypt. One value per
 * text column that holds any is tried; the copy goes ahead when at least
 * one decrypts (a value that does not may have been unreadable on SQLite
 * already, and is copied as it is). Returns how many were checked.
 */
function checkSessionSecret(source: SqliteSource, tables: readonly CopyTable[], warn: (line: string) => void): number {
  const samples = source.textSamples(tables, ENCRYPTED_SECRET_PREFIX);
  if (samples.length === 0) return 0;
  const advice =
    "The copy keeps stored secrets encrypted, so PostgreSQL needs the same secret: run it with the SESSION_SECRET " +
    "(and SESSION_SECRET_PREVIOUS, if set) of the web container.";
  if (!process.env.SESSION_SECRET?.trim()) {
    throw new CopyRefusedError(`SESSION_SECRET is not set. ${advice}`);
  }
  const failed = samples.filter((sample) => {
    try {
      decryptSecret(sample.value);
      return false;
    } catch {
      return true;
    }
  });
  const where = (list: typeof samples) => list.map((sample) => `${sample.table}.${sample.column}`).join(", ");
  if (failed.length === samples.length) {
    throw new CopyRefusedError(`SESSION_SECRET does not decrypt the secrets stored in the SQLite database (${where(failed)}). ${advice}`);
  }
  if (failed.length > 0) {
    warn(
      `Some stored secrets do not decrypt with SESSION_SECRET (${where(failed)}); they are copied as they are. ` +
        "Re-enter them in the dashboard if they are needed."
    );
  }
  return samples.length;
}

/** Refuses a target an Ingressi process (a web container) is connected to. */
async function assertNoApplicationConnected(connection: pg.PoolClient): Promise<void> {
  const { rows } = await connection.query<{ sessions: number }>(
    `SELECT count(*)::int AS sessions FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = $1 AND pid <> pg_backend_pid()`,
    [APPLICATION_NAME]
  );
  const sessions = rows[0]?.sessions ?? 0;
  if (sessions > 0) {
    throw new CopyRefusedError(
      `Ingressi is connected to the PostgreSQL database (${sessions} ${sessions === 1 ? "session" : "sessions"}). ` +
        "Stop every web container that uses it, then run the copy again."
    );
  }
}

/** The tables of `tables` that hold rows in the target, with their counts. */
async function occupiedTables(connection: pg.PoolClient, tables: readonly CopyTable[]): Promise<TableCount[]> {
  const { rows } = await connection.query<Record<string, boolean>>(
    `SELECT ${tables.map((table) => `EXISTS (SELECT 1 FROM ${quoteIdentifier(table.name)}) AS ${quoteIdentifier(table.name)}`).join(", ")}`
  );
  const occupied: TableCount[] = [];
  for (const table of tables) {
    if (!rows[0]?.[table.name]) continue;
    const { rows: counted } = await connection.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${quoteIdentifier(table.name)}`
    );
    occupied.push({ table: table.name, rows: counted[0]?.count ?? 0 });
  }
  return occupied;
}

/**
 * The enabled triggers on `tables`. They are disabled while the rows are
 * copied: a trigger that fills in a value (users.disabledAt) would change
 * the row being copied.
 */
async function enabledTriggers(connection: pg.PoolClient, tables: readonly CopyTable[]): Promise<Array<{ table: string; trigger: string }>> {
  const { rows } = await connection.query<{ table: string; trigger: string }>(
    `SELECT c.relname AS "table", t.tgname AS "trigger"
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relnamespace = current_schema()::regnamespace AND NOT t.tgisinternal AND t.tgenabled <> 'D'
        AND c.relname = ANY($1::text[])
      ORDER BY c.relname, t.tgname`,
    [tables.map((table) => table.name)]
  );
  return rows;
}

async function setTriggers(
  connection: pg.PoolClient,
  triggers: ReadonlyArray<{ table: string; trigger: string }>,
  action: "DISABLE" | "ENABLE"
): Promise<void> {
  for (const { table, trigger } of triggers) {
    try {
      await connection.query(`ALTER TABLE ${quoteIdentifier(table)} ${action} TRIGGER ${quoteIdentifier(trigger)}`);
    } catch (error) {
      if (errorCode(error) === INSUFFICIENT_PRIVILEGE) {
        throw new CopyRefusedError(
          `The PostgreSQL user does not own the table ${table} (${messageOf(error)}). ` +
            "Run the copy as the user that owns Ingressi's tables, the one the web container connects as."
        );
      }
      throw error;
    }
  }
}

/** Where a row is, for messages: its integer key, or its rowid (other keys may be identifiers worth not printing). */
function rowLabel(table: CopyTable, row: SourceRow): string {
  if (table.primaryKey.length === 1) {
    const index = table.columns.findIndex((column) => column.name === table.primaryKey[0]);
    const value = row.values[index];
    if (typeof value === "bigint" || typeof value === "number") return `the row with ${table.primaryKey[0]} ${value}`;
  }
  return `the row with rowid ${row.rowid}`;
}

/** Copies `table`, `batchSize` rows per INSERT; returns the number of rows. */
async function copyTable(source: SqliteSource, connection: pg.PoolClient, table: CopyTable, batchSize: number): Promise<number> {
  const { columns } = table;
  // One array parameter per column, unnested into rows: one statement per
  // batch whatever the number of columns, ids included.
  const insert =
    `INSERT INTO ${quoteIdentifier(table.name)} (${columns.map((column) => quoteIdentifier(column.name)).join(", ")}) ` +
    `SELECT * FROM unnest(${columns.map((column, index) => `$${index + 1}::${PG_TYPE_OF_KIND[column.kind]}[]`).join(", ")})`;
  let copied = 0;
  for (const batch of source.batches(table, batchSize)) {
    const parameters: PgValue[][] = columns.map(() => []);
    for (const row of batch) {
      columns.forEach((column, index) => {
        try {
          parameters[index].push(toPostgresValue(column.kind, row.values[index]));
        } catch (error) {
          if (!(error instanceof UnsupportedValueError)) throw error;
          throw new CopyRefusedError(
            `${table.name}.${column.name} of ${rowLabel(table, row)} ${error.problem}. ` +
              "Correct or delete that row with Ingressi stopped, then run the copy again."
          );
        }
      });
    }
    try {
      await connection.query(insert, parameters);
    } catch (error) {
      throw new Error(`Copying the table ${table.name} failed: ${messageOf(error)}`, { cause: error });
    }
    copied += batch.length;
  }
  return copied;
}

/**
 * Moves the identity of `table` past both the highest id copied and the
 * highest id SQLite's AUTOINCREMENT handed out (sqlite_sequence, which
 * deleted rows may exceed), so no id is handed out twice. As
 * resyncIdentity() in src/lib/db/ops.ts, which this mirrors on the copy's
 * own connection, it never moves an identity back.
 */
async function resyncIdentity(connection: pg.PoolClient, table: CopyTable, handedOut: bigint | null): Promise<void> {
  if (!table.identity) return;
  const highestHandedOut = handedOut !== null && handedOut > 0n ? handedOut.toString() : "0";
  try {
    await connection.query(
      `SELECT setval(identity.seq, greatest(coalesce(highest.id, 0), $2::bigint, coalesce(pg_sequence_last_value(identity.seq), 0)), true)
         FROM (SELECT pg_get_serial_sequence($1, $3)::regclass AS seq) AS identity,
              (SELECT max(${quoteIdentifier(table.identity)}) AS id FROM ${quoteIdentifier(table.name)}) AS highest
        WHERE highest.id IS NOT NULL OR $2::bigint > 0 OR pg_sequence_last_value(identity.seq) IS NOT NULL`,
      [quoteIdentifier(table.name), highestHandedOut, table.identity]
    );
  } catch (error) {
    throw new Error(`Setting the next id of the table ${table.name} failed: ${messageOf(error)}`, { cause: error });
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Copies the SQLite database into PostgreSQL (see the module comment). Throws CopyRefusedError or CopyVerificationError. */
export async function copySqliteToPostgres(options: CopyOptions): Promise<CopyResult> {
  const started = performance.now();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const log = options.log ?? (() => {});
  const warn = options.warn ?? log;
  const tables = copyTables();

  const source = SqliteSource.open(options.sourcePath);
  try {
    const sourceSchema = readSourceSchema(source, tables);
    for (const name of sourceSchema.unknownTables) {
      warn(`Not copied: the SQLite table ${name} is not part of this version's schema, and Ingressi does not use it.`);
    }
    const secretsChecked = checkSessionSecret(source, tables, warn);

    const pool = createPostgresPool({ ...options.target, max: 2, application_name: COPY_APPLICATION_NAME });
    try {
      try {
        await preparePostgresDatabase(pool);
      } catch (error) {
        if (error instanceof DatabaseStartupError) throw new CopyRefusedError(error.message);
        throw error;
      }

      const connection = await pool.connect();
      const unwatch = watchHeldConnection(connection, "the copy");
      let broken: Error | undefined;
      try {
        return await inTransaction(
          connection,
          BEGIN_COPY,
          async () => {
            await connection.query(COPY_SESSION_SETTINGS);
            assertSameSchemaVersion(sourceSchema.newestMigration, await targetSchemaVersion(connection));
            await assertNoApplicationConnected(connection);

            const replaced = await occupiedTables(connection, tables);
            if (replaced.length > 0) {
              const list = replaced.map((entry) => `${entry.table} ${entry.rows}`).join(", ");
              if (!options.replace) {
                throw new CopyRefusedError(
                  `The PostgreSQL database already holds Ingressi data (rows per table: ${list}). The copy only fills an ` +
                    "empty database. To delete that data and copy over it, run the copy again with --replace."
                );
              }
              const total = replaced.reduce((sum, entry) => sum + entry.rows, 0);
              warn(
                `--replace: deleting ${plural(total, "row", "rows")} in ${plural(replaced.length, "table", "tables")} ` +
                  `of the PostgreSQL database before copying (${list}).`
              );
              await connection.query(`TRUNCATE ${tables.map((table) => quoteIdentifier(table.name)).join(", ")} RESTART IDENTITY`);
            }

            const triggers = await enabledTriggers(connection, tables);
            await setTriggers(connection, triggers, "DISABLE");
            const copied: TableCount[] = [];
            for (const table of tables) {
              const rows = await copyTable(source, connection, table, batchSize);
              copied.push({ table: table.name, rows });
              if (rows > 0) log(`${table.name}: ${plural(rows, "row", "rows")} copied`);
            }
            await setTriggers(connection, triggers, "ENABLE");
            for (const table of tables) await resyncIdentity(connection, table, source.sequence(table.name));

            log("Comparing both databases table by table...");
            const verify = await compareTables(source, connection, tables, batchSize);
            if (!verify.ok) throw new CopyVerificationError(verify);
            return {
              tables: copied,
              rows: copied.reduce((sum, entry) => sum + entry.rows, 0),
              replaced,
              notCopied: sourceSchema.unknownTables,
              secretsChecked,
              verify,
              durationMs: performance.now() - started,
            };
          },
          { commit: true }
        );
      } catch (error) {
        if (!(error instanceof CopyRefusedError || error instanceof CopyVerificationError)) {
          broken = error instanceof Error ? error : new Error(String(error));
        }
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
