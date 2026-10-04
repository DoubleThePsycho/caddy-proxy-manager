/**
 * Types of the asynchronous, dialect-neutral database layer
 * (src/lib/db/README.md). Code that runs queries takes these types, never a
 * driver's own database type, so the same code runs on SQLite and
 * PostgreSQL.
 */
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { BaseSQLiteDatabase, SQLiteTransaction } from "drizzle-orm/sqlite-core";
import type * as schema from "./schema";

/** Every table of the application, as the query builders see them. */
export type AppSchema = typeof schema;
export type AppRelations = ExtractTablesWithRelations<AppSchema>;

/** Options of `db.transaction(fn, options)`. */
export interface TransactionOptions {
  /**
   * SQLite's BEGIN mode: "deferred" (the default) takes the write lock at the
   * first write, "immediate" at BEGIN. Nested transactions (savepoints)
   * ignore it.
   */
  behavior?: "deferred" | "immediate" | "exclusive";
  /**
   * A transaction that only reads: a consistent snapshot, and any write in it
   * fails. Nested transactions inherit the outer transaction's mode.
   */
  readOnly?: boolean;
}

type DrizzleAsyncDatabase = BaseSQLiteDatabase<"async", unknown, AppSchema, AppRelations>;
type DrizzleAsyncTransaction = SQLiteTransaction<"async", unknown, AppSchema, AppRelations>;

/** Runs `fn` in a transaction (a savepoint when one is already open) and returns its result. */
export type TransactionFn = <T>(fn: (tx: AppTx) => Promise<T>, options?: TransactionOptions) => Promise<T>;

/**
 * An open transaction. Its queries run in the transaction; `tx.transaction()`
 * opens a savepoint and `tx.rollback()` rolls the transaction back (it throws
 * TransactionRollbackError, which `db.transaction` rethrows).
 */
export type AppTx = Omit<DrizzleAsyncTransaction, "transaction"> & { transaction: TransactionFn };

/**
 * The application database. Every query is awaited; inside a transaction the
 * default `db` runs in that transaction (helpers that use it join it).
 */
export type AppDb = Omit<DrizzleAsyncDatabase, "transaction"> & { transaction: TransactionFn };

/** The database or an open transaction: what a helper that runs queries takes. */
export type DbExecutor = AppDb | AppTx;

/** What a helper that only reads needs (a read-only transaction qualifies). */
export type DbReader = Pick<DbExecutor, "select" | "selectDistinct" | "$count" | "query" | "$with" | "with">;

/** What a helper that reads and writes needs. */
export type DbWriter = DbReader & Pick<DbExecutor, "insert" | "update" | "delete">;
