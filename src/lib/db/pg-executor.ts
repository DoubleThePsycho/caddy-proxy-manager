/**
 * The asynchronous database facade on PostgreSQL (src/lib/db/README.md):
 * Drizzle's node-postgres driver over a pool (src/lib/db/postgres.ts), cast
 * to the same `AppDb` type as on SQLite, with the same behaviour where it
 * matters to the code that uses it:
 *
 * - ambient transactions: `db.transaction(fn)` runs `fn` in an
 *   AsyncLocalStorage context, and the default `db` used anywhere in that
 *   context runs in the transaction. A transaction opened inside another
 *   one is a savepoint; savepoints opened side by side run one after the
 *   other. A query that arrives after its transaction finished throws
 *   TransactionEscapeError in development and tests; in production it runs
 *   on its own, outside the transaction.
 * - each transaction runs on one pooled connection. A writing transaction
 *   starts with `BEGIN` (READ COMMITTED) and pg_advisory_xact_lock on the
 *   write key, so writing transactions are serialised across every process
 *   that uses the database, as SQLite serialises them (D4). In front of it
 *   an in-process FIFO queue lets one writer per process wait for the lock,
 *   instead of one pooled connection per waiting writer.
 * - `{ readOnly: true }` is `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`:
 *   a consistent snapshot, writes fail, and it takes no lock, so it never
 *   waits for writers.
 * - statements outside a transaction run at once on any pooled connection.
 * - a writing transaction whose callback caught a failed statement and went
 *   on is rolled back by PostgreSQL even when asked to commit; that is
 *   reported (TransactionAbortedError) instead of passing for a commit.
 */
import {
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
  type SQL,
} from "drizzle-orm";
import { NodePgDatabase, NodePgSession, NodePgTransaction } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import type pg from "pg";
import * as schema from "./schema";
import {
  ambientFrameOf,
  assertTransactionBehavior,
  escapesThrow,
  FifoLock,
  openFrame,
  outsideTransaction,
  startWatchdog,
  targets,
  TransactionEscapeError,
  transactionContext,
  transactionEnded,
  type TransactionFrame,
  type TransactionRoot,
} from "./executor-core";
import { ADVISORY_LOCK_NAMESPACE, PG_TYPES, watchHeldConnection, WRITE_LOCK_ID } from "./postgres";
import type { AppDb, AppRelations, AppSchema, AppTx, TransactionFn, TransactionOptions } from "./types";

/**
 * A writing transaction ended in ROLLBACK because a statement in it failed
 * and the callback caught the error and went on.
 */
export class TransactionAbortedError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(
      "The transaction was rolled back: a statement in it failed and the error was caught inside the transaction. " +
        "On PostgreSQL a failed statement aborts the whole transaction; run a statement that may fail in a nested " +
        "transaction (a savepoint) to carry on after it.",
      options
    );
    this.name = "TransactionAbortedError";
  }
}

/** What the executor needs of a pool: a pg.Pool, or a wrapper around one (tests). */
export interface PgPoolLike {
  query(config: pg.QueryConfig, values?: unknown[]): Promise<pg.QueryResult>;
  connect(): Promise<pg.PoolClient>;
}

export interface PostgresExecutorOptions {
  /** Drizzle's column name casing. */
  casing?: "snake_case" | "camelCase";
  /** What `db.$client` returns (test databases only); nothing when unset. */
  client?: unknown;
}

interface PgTransactionRoot extends TransactionRoot {
  readonly connection: pg.PoolClient;
  /** Stops listening for errors on the connection (before it goes back to the pool). */
  readonly unwatch: () => void;
}

type SchemaConfig = {
  fullSchema: AppSchema;
  schema: AppRelations;
  tableNamesMap: Record<string, string>;
};

/** What Drizzle's session calls: query(config, values). */
type RoutedClient = { query(config: pg.QueryConfig | string, values?: unknown[]): Promise<pg.QueryResult> };

const BEGIN_WRITE = `BEGIN; SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_NAMESPACE}, ${WRITE_LOCK_ID})`;
const BEGIN_READ_ONLY = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";

/** The SQLSTATE of "current transaction is aborted, commands ignored until end of transaction block". */
const IN_FAILED_TRANSACTION = "25P02";

function lastResult(result: pg.QueryResult | pg.QueryResult[]): pg.QueryResult {
  return Array.isArray(result) ? result[result.length - 1] : result;
}

/**
 * The asynchronous facade over one PostgreSQL pool: its transactions, its
 * in-process writer queue and its `db`.
 */
export class PostgresExecutor {
  readonly dialect: PgDialect;
  /** The facade: delegates to the open transaction of the calling context, if any. */
  readonly db: AppDb;
  /** Writing transactions of this process, one at a time, in arrival order. */
  private readonly writers = new FifoLock();
  private readonly schemaConfig: SchemaConfig;
  private readonly rootDb: NodePgDatabase<AppSchema>;

  constructor(
    readonly pool: PgPoolLike,
    options: PostgresExecutorOptions = {}
  ) {
    this.dialect = new PgDialect({ casing: options.casing });
    const relational = extractTablesRelationalConfig<AppRelations>(schema, createTableRelationsHelpers);
    this.schemaConfig = { fullSchema: schema, schema: relational.tables, tableNamesMap: relational.tableNamesMap };
    const session = new NodePgSession<AppSchema, AppRelations>(
      this.routedClient(null) as unknown as pg.PoolClient,
      this.dialect,
      this.schemaConfig,
      {}
    );
    this.rootDb = new NodePgDatabase<AppSchema>(this.dialect, session, this.schemaConfig);

    const transaction: TransactionFn = (fn, transactionOptions) => this.transaction(null, fn, transactionOptions);
    const rootDb = this.rootDb;
    Object.defineProperty(rootDb, "transaction", { value: transaction, writable: true, configurable: true, enumerable: false });
    const exposed = options.client;
    this.db = new Proxy(rootDb, {
      get: (target, property) => {
        if (property === "transaction") return Reflect.get(target, property, target);
        if (property === "$client" && exposed !== undefined) return exposed;
        // As on SQLite: builders are bound to the calling context's
        // transaction when they are created.
        const ambient = ambientFrameOf(this);
        const base: object = ambient ? (openFrame(ambient) ?? ambient).tx : target;
        const value: unknown = Reflect.get(base, property, base);
        return typeof value === "function" ? value.bind(base) : value;
      },
    }) as unknown as AppDb;
    targets.set(this.db, { executor: this, frame: null });
    targets.set(rootDb, { executor: this, frame: null });
  }

  /** Whether the calling async context is inside an open transaction on this database. */
  inTransaction(): boolean {
    const frame = ambientFrameOf(this);
    return !!frame && openFrame(frame) !== null;
  }

  /** The transaction a tx object of this database is bound to; null for the database itself. */
  frameOf(on?: object): TransactionFrame | null {
    if (!on) return null;
    const target = targets.get(on);
    return target && target.executor === this ? target.frame : null;
  }

  /** Compiles a Drizzle SQL fragment for PostgreSQL. */
  compile(query: SQL): { sql: string; params: unknown[] } {
    return this.dialect.sqlToQuery(query);
  }

  /**
   * One raw statement with object rows: in the transaction `on` (a tx
   * object) or the calling context belongs to, or on its own.
   */
  async query(sql: string, params: readonly unknown[] = [], on?: object): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    const result = lastResult(
      (await this.runQuery(this.frameOf(on), { text: sql }, params.length > 0 ? [...params] : undefined)) as
        | pg.QueryResult
        | pg.QueryResult[]
    );
    return { rows: (result.rows ?? []) as Record<string, unknown>[], rowCount: result.rowCount ?? 0 };
  }

  /**
   * Runs `fn` after the writing transactions of this process that came
   * before it, while none is open (whole-database work).
   */
  async runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.inTransaction()) {
      throw new Error("runExclusive cannot be used inside a transaction");
    }
    await this.writers.acquire();
    try {
      return await outsideTransaction(fn);
    } finally {
      this.writers.release();
    }
  }

  /** `db.transaction` / `tx.transaction`: a transaction, or a savepoint inside the open one. */
  async transaction<T>(
    bound: TransactionFrame | null,
    fn: (tx: AppTx) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    const frame = bound ?? ambientFrameOf(this);
    if (frame) {
      const active = openFrame(frame);
      if (active) return this.savepoint(active, fn);
      if (escapesThrow()) throw new TransactionEscapeError();
    }
    return this.rootTransaction(fn, options);
  }

  // ── Statements ──

  private routedClient(bound: TransactionFrame | null): RoutedClient {
    return { query: (config, values) => this.runQuery(bound, config, values) };
  }

  /**
   * Runs one statement where it belongs: on the connection of the
   * transaction `bound` (a tx object's) or the calling context belongs to,
   * or, outside one, on any pooled connection.
   */
  private async runQuery(
    bound: TransactionFrame | null,
    config: pg.QueryConfig | string,
    values?: unknown[]
  ): Promise<pg.QueryResult> {
    const query: pg.QueryConfig =
      typeof config === "string" ? { text: config, types: PG_TYPES } : { ...config, types: PG_TYPES };
    const frame = bound ?? ambientFrameOf(this);
    if (frame) {
      if (openFrame(frame)) return (frame.root as PgTransactionRoot).connection.query(query, values);
      if (escapesThrow()) throw new TransactionEscapeError();
    }
    return this.pool.query(query, values);
  }

  // ── Transactions ──

  private createFrame(root: PgTransactionRoot, parent: TransactionFrame | null): TransactionFrame {
    const frame: TransactionFrame = {
      root,
      parent,
      depth: parent ? parent.depth + 1 : 0,
      closed: false,
      children: new FifoLock(),
      // Set below, once the transaction object exists.
      tx: undefined as unknown as AppTx,
    };
    const session = new NodePgSession<AppSchema, AppRelations>(
      this.routedClient(frame) as unknown as pg.PoolClient,
      this.dialect,
      this.schemaConfig,
      {}
    );
    const tx = new NodePgTransaction<AppSchema, AppRelations>(this.dialect, session, this.schemaConfig, frame.depth);
    const nested: TransactionFn = (fn, options) => this.transaction(frame, fn, options);
    Object.defineProperty(tx, "transaction", { value: nested, enumerable: false });
    frame.tx = tx as unknown as AppTx;
    targets.set(tx, { executor: this, frame });
    return frame;
  }

  private async rootTransaction<T>(fn: (tx: AppTx) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    // Every writing transaction takes the write lock at BEGIN: the SQLite
    // modes all behave as "immediate" here.
    assertTransactionBehavior(options.behavior ?? "deferred");
    const readOnly = options.readOnly === true;

    if (!readOnly) await this.writers.acquire();
    const stopWatchdog = readOnly ? () => {} : startWatchdog();
    let connection: pg.PoolClient | undefined;
    let unwatch = () => {};
    try {
      connection = await this.pool.connect();
      unwatch = watchHeldConnection(connection, "a transaction");
      await connection.query(readOnly ? BEGIN_READ_ONLY : BEGIN_WRITE);
    } catch (error) {
      if (connection) {
        const broken = await this.rollbackQuietly(connection);
        unwatch();
        connection.release(broken);
      }
      stopWatchdog();
      if (!readOnly) this.writers.release();
      throw error;
    }

    const root: PgTransactionRoot = { executor: this, readOnly, closed: false, savepoints: 0, connection, unwatch };
    const frame = this.createFrame(root, null);
    let result: T;
    try {
      result = await transactionContext.run(frame, () => fn(frame.tx));
    } catch (error) {
      frame.closed = true;
      root.closed = true;
      try {
        await this.endTransaction(root, false, stopWatchdog);
      } finally {
        transactionEnded(root);
      }
      throw error;
    }
    frame.closed = true;
    root.closed = true;
    try {
      await this.endTransaction(root, true, stopWatchdog);
    } finally {
      transactionEnded(root);
    }
    return result;
  }

  /** ROLLBACK; returns the error when it failed (the connection is then broken and must not be reused). */
  private async rollbackQuietly(connection: pg.PoolClient): Promise<Error | undefined> {
    try {
      await connection.query("ROLLBACK");
      return undefined;
    } catch (error) {
      console.error("[db] Failed to roll back a transaction:", error);
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * COMMIT (or ROLLBACK), then give the connection back (closing it when it
   * failed) and let the next writer in, whatever fails. Only a failed COMMIT
   * throws.
   */
  private async endTransaction(root: PgTransactionRoot, commit: boolean, stopWatchdog: () => void): Promise<void> {
    const { connection } = root;
    let broken: Error | undefined;
    try {
      if (!commit) {
        broken = await this.rollbackQuietly(connection);
        return;
      }
      let result: pg.QueryResult;
      try {
        result = await connection.query("COMMIT");
      } catch (error) {
        broken = await this.rollbackQuietly(connection);
        throw error;
      }
      // A transaction in which a statement failed ends in ROLLBACK even when
      // asked to commit. A read-only one lost nothing.
      if (result.command === "ROLLBACK" && !root.readOnly) throw new TransactionAbortedError();
    } finally {
      root.unwatch();
      connection.release(broken);
      stopWatchdog();
      if (!root.readOnly) this.writers.release();
    }
  }

  private async savepoint<T>(parent: TransactionFrame, fn: (tx: AppTx) => Promise<T>): Promise<T> {
    await parent.children.acquire();
    const root = parent.root as PgTransactionRoot;
    try {
      if (root.closed) {
        if (escapesThrow()) throw new TransactionEscapeError();
        // Production: the enclosing transaction is gone; run on its own.
        return await outsideTransaction(() => this.rootTransaction(fn, { readOnly: root.readOnly }));
      }
      const name = `ingressi_sp_${++root.savepoints}`;
      await root.connection.query(`SAVEPOINT ${name}`);
      const frame = this.createFrame(root, parent);
      let result: T;
      try {
        result = await transactionContext.run(frame, () => fn(frame.tx));
      } catch (error) {
        frame.closed = true;
        if (!root.closed) {
          try {
            await root.connection.query(`ROLLBACK TO SAVEPOINT ${name}`);
            await root.connection.query(`RELEASE SAVEPOINT ${name}`);
          } catch (rollbackError) {
            console.error("[db] Failed to roll back a savepoint:", rollbackError);
          }
        }
        throw error;
      }
      frame.closed = true;
      if (root.closed) {
        if (escapesThrow()) throw new TransactionEscapeError();
        return result;
      }
      try {
        await root.connection.query(`RELEASE SAVEPOINT ${name}`);
      } catch (error) {
        try {
          await root.connection.query(`ROLLBACK TO SAVEPOINT ${name}`);
          await root.connection.query(`RELEASE SAVEPOINT ${name}`);
        } catch {
          // The RELEASE error below is the one to report.
        }
        if ((error as { code?: unknown }).code === IN_FAILED_TRANSACTION) throw new TransactionAbortedError({ cause: error });
        throw error;
      }
      return result;
    } finally {
      parent.children.release();
    }
  }
}
