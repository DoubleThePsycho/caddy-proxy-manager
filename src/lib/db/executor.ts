/**
 * The asynchronous database facade (src/lib/db/README.md). `appDb` is the
 * application database on the configured dialect: SqliteExecutor below
 * (Drizzle's sqlite-proxy driver over the application's SQLite connection,
 * src/lib/db/sqlite.ts) or PostgresExecutor (pg-executor.ts, Drizzle's
 * node-postgres driver over a pool). Both give
 *
 * - ambient transactions: `db.transaction(fn)` runs `fn` in an
 *   AsyncLocalStorage context, and the default `db` used anywhere in that
 *   context runs in the transaction (a helper that takes no `tx` joins it).
 *   A transaction opened inside another one is a savepoint. A query that
 *   arrives after its transaction finished (a promise in the callback that
 *   was not awaited) throws TransactionEscapeError in development and tests;
 *   in production it runs on its own, outside the transaction.
 * - options `{ behavior: "immediate" }` and `{ readOnly: true }`.
 * - in development, a watchdog that logs a transaction holding the database
 *   for more than 250 ms: transactions must contain database work only.
 *
 * On SQLite there is one process-wide FIFO gate per connection: while a
 * transaction is open, every query and transaction from outside its context
 * waits, in arrival order, so a transaction's reads and writes are never
 * interleaved with another request's (one connection, as with the
 * synchronous driver). Statements outside a transaction run at once when the
 * gate is free. `behavior: "immediate"` is BEGIN IMMEDIATE and `readOnly`
 * sets PRAGMA query_only for the duration. PostgreSQL: see pg-executor.ts.
 */
import {
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
  type SQL,
} from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import {
  SQLiteProxyTransaction,
  SQLiteRemoteSession,
  SqliteRemoteDatabase,
} from "drizzle-orm/sqlite-proxy";
import * as schema from "./schema";
import { getDialect } from "./dialect";
import {
  ambientFrameOf,
  escapesThrow,
  FifoLock,
  openFrame,
  outsideTransaction,
  startWatchdog,
  targets,
  TransactionEscapeError,
  transactionContext,
  type TransactionFrame,
  type TransactionRoot,
} from "./executor-core";
import { PostgresExecutor } from "./pg-executor";
import { getPostgresPool } from "./postgres";
import {
  createSqliteStatementRunner,
  runSqliteProxyStatement,
  sqlite,
  type SqliteClient,
  type SqliteQueryResult,
  type SqliteStatementRunner,
} from "./sqlite";
import type { AppDb, AppRelations, AppSchema, AppTx, TransactionFn, TransactionOptions } from "./types";

export type { AppDb, AppTx, DbExecutor, DbReader, DbWriter, TransactionOptions } from "./types";
export {
  inTransaction,
  outsideTransaction,
  setTransactionWatchdog,
  TransactionEscapeError,
  type TransactionFrame,
} from "./executor-core";
export { PostgresExecutor, TransactionAbortedError, type PgPoolLike } from "./pg-executor";

/** The executor behind a database facade, whichever the dialect. */
export type DatabaseExecutor = SqliteExecutor | PostgresExecutor;

type GlobalExecutorState = typeof globalThis & {
  __ingressiDbExecutors?: WeakMap<object, SqliteExecutor>;
  __ingressiPgExecutor?: PostgresExecutor;
};

const globalState = globalThis as GlobalExecutorState;
const executorsByClient = (globalState.__ingressiDbExecutors ??= new WeakMap<object, SqliteExecutor>());

export interface DbTarget {
  executor: DatabaseExecutor;
  /** The transaction a tx object is bound to; null for a database facade. */
  frame: TransactionFrame | null;
}

// ── Executor ──

const BEGIN_STATEMENTS = {
  deferred: "BEGIN DEFERRED",
  immediate: "BEGIN IMMEDIATE",
  exclusive: "BEGIN EXCLUSIVE",
} as const;

export interface SqliteExecutorOptions {
  /** Drizzle's column name casing, as the synchronous instance for the same database uses it. */
  casing?: "snake_case" | "camelCase";
  /** Makes `db.$client` return the connection (test databases only). */
  exposeClient?: boolean;
}

type SchemaConfig = {
  fullSchema: AppSchema;
  schema: AppRelations;
  tableNamesMap: Record<string, string>;
};

type ProxyMethod = "run" | "all" | "values" | "get";

/**
 * The asynchronous facade over one SQLite connection: its gate, its
 * transactions and its `db`. One per connection (getSqliteExecutor).
 */
export class SqliteExecutor {
  readonly runner: SqliteStatementRunner;
  readonly dialect: SQLiteAsyncDialect;
  /** The facade: delegates to the open transaction of the calling context, if any. */
  readonly db: AppDb;
  private readonly gate = new FifoLock();
  private readonly schemaConfig: SchemaConfig;
  private readonly rootDb: SqliteRemoteDatabase<AppSchema>;

  constructor(client: SqliteClient, options: SqliteExecutorOptions = {}) {
    this.runner = createSqliteStatementRunner(client);
    this.dialect = new SQLiteAsyncDialect({ casing: options.casing });
    const relational = extractTablesRelationalConfig<AppRelations>(schema, createTableRelationsHelpers);
    this.schemaConfig = { fullSchema: schema, schema: relational.tables, tableNamesMap: relational.tableNamesMap };
    const session = new SQLiteRemoteSession<AppSchema, AppRelations>(
      (sql, params, method) => this.runProxy(null, sql, params, method),
      this.dialect,
      this.schemaConfig
    );
    this.rootDb = new SqliteRemoteDatabase<AppSchema>("async", this.dialect, session, this.schemaConfig);

    const transaction: TransactionFn = (fn, transactionOptions) => this.transaction(null, fn, transactionOptions);
    const rootDb = this.rootDb;
    // An own property of the target, so that a test can replace it (vi.spyOn).
    Object.defineProperty(rootDb, "transaction", { value: transaction, writable: true, configurable: true, enumerable: false });
    this.db = new Proxy(rootDb, {
      get: (target, property) => {
        if (property === "transaction") return Reflect.get(target, property, target);
        if (property === "$client" && options.exposeClient) return client;
        // Builders are bound to the calling context's transaction when they
        // are created (a finished one: its queries are escapes), not when
        // they run: Bun does not carry the async context into a builder that
        // an async function returns without awaiting.
        const ambient = this.ambientFrame();
        const base: object = ambient ? (openFrame(ambient) ?? ambient).tx : target;
        const value: unknown = Reflect.get(base, property, base);
        return typeof value === "function" ? value.bind(base) : value;
      },
    }) as unknown as AppDb;
    targets.set(this.db, { executor: this, frame: null });
    targets.set(rootDb, { executor: this, frame: null });
  }

  /** The open transaction frame of the calling async context on this connection, if any. */
  private ambientFrame(): TransactionFrame | null {
    return ambientFrameOf(this);
  }

  /** Whether the calling async context is inside an open transaction on this connection. */
  inTransaction(): boolean {
    const frame = this.ambientFrame();
    return !!frame && openFrame(frame) !== null;
  }

  /**
   * Runs `operation` (synchronous work on the connection) in the right place:
   * in the transaction `bound` (a tx object's) or the calling context belongs
   * to, or, outside one, when the gate is free.
   */
  async run<T>(bound: TransactionFrame | null, operation: () => T): Promise<T> {
    const frame = bound ?? this.ambientFrame();
    if (frame) {
      if (openFrame(frame)) return operation();
      if (escapesThrow()) throw new TransactionEscapeError();
    }
    if (this.gate.tryAcquire()) {
      try {
        return operation();
      } finally {
        this.gate.release();
      }
    }
    await this.gate.acquire();
    try {
      return operation();
    } finally {
      this.gate.release();
    }
  }

  /** Drizzle's sqlite-proxy callback ("get" returns one row as `rows`, not an array of rows). */
  private runProxy(
    bound: TransactionFrame | null,
    sql: string,
    params: unknown[],
    method: ProxyMethod
  ): Promise<{ rows: unknown[] }> {
    return this.run(bound, () => runSqliteProxyStatement(this.runner, sql, params, method)) as Promise<{ rows: unknown[] }>;
  }

  /**
   * One raw statement with object rows, through the gate (or in the
   * transaction `on`, a tx object or the calling context, belongs to).
   */
  query(sql: string, params: readonly unknown[] = [], on?: object): Promise<SqliteQueryResult> {
    return this.run(this.frameOf(on), () => this.runner.query(sql, params));
  }

  /** The transaction a tx object of this connection is bound to; null for the database itself. */
  frameOf(on?: object): TransactionFrame | null {
    if (!on) return null;
    const target = targets.get(on);
    return target && target.executor === this ? target.frame : null;
  }

  /** Compiles a Drizzle SQL fragment for this connection. */
  compile(query: SQL): { sql: string; params: unknown[] } {
    return this.dialect.sqlToQuery(query);
  }

  /**
   * Runs `fn` with the gate held and no transaction open, after the
   * transactions before it (VACUUM and similar whole-database work).
   */
  async runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.inTransaction()) {
      throw new Error("runExclusive cannot be used inside a transaction");
    }
    await this.gate.acquire();
    try {
      return await outsideTransaction(fn);
    } finally {
      this.gate.release();
    }
  }

  /** `db.transaction` / `tx.transaction`: a transaction, or a savepoint inside the open one. */
  async transaction<T>(
    bound: TransactionFrame | null,
    fn: (tx: AppTx) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    const frame = bound ?? this.ambientFrame();
    if (frame) {
      const active = openFrame(frame);
      if (active) return this.savepoint(active, fn);
      if (escapesThrow()) throw new TransactionEscapeError();
    }
    return this.rootTransaction(fn, options);
  }

  private createFrame(root: TransactionRoot, parent: TransactionFrame | null): TransactionFrame {
    const frame = {
      root,
      parent,
      depth: parent ? parent.depth + 1 : 0,
      closed: false,
      children: new FifoLock(),
    } as TransactionFrame;
    const session = new SQLiteRemoteSession<AppSchema, AppRelations>(
      (sql, params, method) => this.runProxy(frame, sql, params, method),
      this.dialect,
      this.schemaConfig
    );
    const tx = new SQLiteProxyTransaction<AppSchema, AppRelations>(
      "async",
      this.dialect,
      session,
      this.schemaConfig,
      frame.depth
    );
    const nested: TransactionFn = (fn, options) => this.transaction(frame, fn, options);
    Object.defineProperty(tx, "transaction", { value: nested, enumerable: false });
    frame.tx = tx as unknown as AppTx;
    targets.set(tx, { executor: this, frame });
    return frame;
  }

  private async rootTransaction<T>(fn: (tx: AppTx) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    const behavior = options.behavior ?? "deferred";
    const begin = BEGIN_STATEMENTS[behavior];
    if (!begin) throw new Error(`Unknown transaction behavior ${JSON.stringify(behavior)}`);
    const root: TransactionRoot = { executor: this, readOnly: options.readOnly === true, closed: false, savepoints: 0 };

    await this.gate.acquire();
    const stopWatchdog = startWatchdog();
    try {
      this.runner.exec(begin);
      if (root.readOnly) this.runner.exec("PRAGMA query_only = ON");
    } catch (error) {
      root.closed = true;
      this.endTransaction(root, false, stopWatchdog);
      throw error;
    }

    const frame = this.createFrame(root, null);
    let result: T;
    try {
      result = await transactionContext.run(frame, () => fn(frame.tx));
    } catch (error) {
      frame.closed = true;
      root.closed = true;
      try {
        this.endTransaction(root, false, stopWatchdog);
      } catch (rollbackError) {
        console.error("[db] Failed to roll back a transaction:", rollbackError);
      }
      throw error;
    }
    frame.closed = true;
    root.closed = true;
    this.endTransaction(root, true, stopWatchdog);
    return result;
  }

  /** COMMIT (or ROLLBACK), restore the connection's mode and release the gate, whatever fails. */
  private endTransaction(root: TransactionRoot, commit: boolean, stopWatchdog: () => void): void {
    try {
      if (commit) {
        try {
          this.runner.exec("COMMIT");
        } catch (error) {
          if (this.runner.inTransaction()) this.runner.exec("ROLLBACK");
          throw error;
        }
      } else if (this.runner.inTransaction()) {
        this.runner.exec("ROLLBACK");
      }
    } finally {
      if (root.readOnly) {
        try {
          this.runner.exec("PRAGMA query_only = OFF");
        } catch (error) {
          console.error("[db] Failed to turn query_only off after a read-only transaction:", error);
        }
      }
      stopWatchdog();
      this.gate.release();
    }
  }

  private async savepoint<T>(parent: TransactionFrame, fn: (tx: AppTx) => Promise<T>): Promise<T> {
    await parent.children.acquire();
    const root = parent.root;
    try {
      if (root.closed) {
        if (escapesThrow()) throw new TransactionEscapeError();
        // Production: the enclosing transaction is gone; run on its own.
        return await outsideTransaction(() => this.rootTransaction(fn));
      }
      const name = `ingressi_sp_${++root.savepoints}`;
      this.runner.exec(`SAVEPOINT ${name}`);
      const frame = this.createFrame(root, parent);
      let result: T;
      try {
        result = await transactionContext.run(frame, () => fn(frame.tx));
      } catch (error) {
        frame.closed = true;
        if (!root.closed) {
          try {
            this.runner.exec(`ROLLBACK TO ${name}`);
            this.runner.exec(`RELEASE ${name}`);
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
        this.runner.exec(`RELEASE ${name}`);
      } catch (error) {
        try {
          this.runner.exec(`ROLLBACK TO ${name}`);
          this.runner.exec(`RELEASE ${name}`);
        } catch {
          // The RELEASE error below is the one to report.
        }
        throw error;
      }
      return result;
    } finally {
      parent.children.release();
    }
  }
}

/** The executor of a SQLite connection, created on first use (one per connection). */
export function getSqliteExecutor(client: SqliteClient, options?: SqliteExecutorOptions): SqliteExecutor {
  let executor = executorsByClient.get(client);
  if (!executor) {
    executor = new SqliteExecutor(client, options);
    executorsByClient.set(client, executor);
  }
  return executor;
}

/**
 * A new executor over `client` (tests: a better-sqlite3 database). The
 * application's own is getAppExecutor().
 */
export function createSqliteExecutor(client: SqliteClient, options?: SqliteExecutorOptions): SqliteExecutor {
  const executor = new SqliteExecutor(client, options);
  executorsByClient.set(client, executor);
  return executor;
}

/**
 * A new executor over a PostgreSQL pool (tests: a pool on a test database,
 * or a second pool standing for another replica). The application's own is
 * getAppExecutor().
 */
export function createPostgresExecutor(
  pool: ConstructorParameters<typeof PostgresExecutor>[0],
  options?: ConstructorParameters<typeof PostgresExecutor>[1]
): PostgresExecutor {
  return new PostgresExecutor(pool, options);
}

/** The executor of the application database, on the configured dialect. */
export function getAppExecutor(): DatabaseExecutor {
  if (getDialect() === "postgres") {
    return (globalState.__ingressiPgExecutor ??= new PostgresExecutor(getPostgresPool()));
  }
  return getSqliteExecutor(sqlite as unknown as SqliteClient);
}

/**
 * The application database, asynchronous: await every query; inside
 * `appDb.transaction(fn)` it runs in that transaction.
 */
export const appDb: AppDb = new Proxy({} as AppDb, {
  get(_target, property) {
    return Reflect.get(getAppExecutor().db, property);
  },
  has(_target, property) {
    return Reflect.has(getAppExecutor().db, property);
  },
});

/**
 * The executor and transaction a db or tx object belongs to (none or
 * `appDb`: the application database's, in the calling context). Throws for
 * an object that is neither (a driver's own database object, say), rather
 * than running the statement somewhere else.
 */
export function resolveDbTarget(on?: object): DbTarget {
  if (on && on !== appDb) {
    const target = targets.get(on);
    if (target) return target as DbTarget;
    throw new Error("Not a database or transaction of src/lib/db: pass appDb, a test database's facade or a transaction");
  }
  return { executor: getAppExecutor(), frame: null };
}
