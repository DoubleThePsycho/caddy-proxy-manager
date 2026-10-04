/**
 * Better Auth's database (src/lib/auth-server.ts): a Kysely instance whose
 * driver runs every statement through the application's executor
 * (src/lib/db/executor.ts on SQLite, pg-executor.ts on PostgreSQL), instead
 * of handing Better Auth a connection of its own.
 *
 * - Better Auth's queries run in an open application transaction when they
 *   are made inside one (a Better Auth API called from `appDb.transaction`),
 *   and otherwise where the application's own queries would: on SQLite
 *   after the open transaction (the gate), on PostgreSQL on any pooled
 *   connection.
 * - Better Auth's own transactions (sign-up, account linking) are
 *   application transactions: on SQLite they hold the gate, on PostgreSQL
 *   they take the write lock, and the application code its hooks run
 *   (through `appDb`) joins them instead of waiting for them on another
 *   connection.
 *
 * SQLite: Better Auth's "sqlite" type writes dates as ISO 8601 text and
 * booleans as 0/1 itself. Results are what Better Auth's bun:sqlite dialect
 * returned: object rows for statements that return rows, otherwise the
 * number of changed rows and the last inserted rowid.
 *
 * PostgreSQL: Better Auth's "postgres" type writes booleans as booleans (the
 * columns are boolean) and dates as Date objects; the IsoDatesPlugin
 * (kysely-iso-dates.ts) stores those as the same ISO 8601 text as on SQLite
 * (D5) and reads the date fields Better Auth's schema declares back as Dates.
 */
import { is } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type AccessMode,
  type CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type KyselyPlugin,
  type QueryCompiler,
  type QueryResult,
  type Transaction,
  type TransactionBuilder,
} from "kysely";
import { getAppExecutor, type PostgresExecutor, type SqliteExecutor } from "./executor";
import { IsoDatesPlugin, type DateColumns } from "./kysely-iso-dates";
import type { AppTx } from "./types";

/** The application executors Better Auth's Kysely runs on. */
type GatedExecutor = SqliteExecutor | PostgresExecutor;

function isPostgresExecutor(executor: GatedExecutor): executor is PostgresExecutor {
  // drizzle's is() rather than instanceof: it also recognises an executor
  // an earlier copy of the module created (development reloads).
  return is(executor.dialect, PgDialect);
}

class GatedSqliteConnection implements DatabaseConnection {
  constructor(
    private readonly executor: SqliteExecutor,
    private readonly on: AppTx | undefined
  ) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const result = await this.executor.query(compiledQuery.sql, compiledQuery.parameters, this.on);
    if (result.returnsRows) return { rows: result.rows as R[] };
    return {
      rows: [],
      numAffectedRows: BigInt(result.changes),
      insertId: BigInt(result.lastInsertRowid),
    };
  }

  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("Streaming queries are not supported on the application database");
  }
}

class GatedPostgresConnection implements DatabaseConnection {
  constructor(
    private readonly executor: PostgresExecutor,
    private readonly on: AppTx | undefined
  ) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const { rows, rowCount } = await this.executor.query(compiledQuery.sql, compiledQuery.parameters, this.on);
    // Kysely reads numAffectedRows only for INSERT, UPDATE and DELETE.
    return { rows: rows as R[], numAffectedRows: BigInt(rowCount) };
  }

  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("Streaming queries are not supported on the application database");
  }
}

const TRANSACTIONS_THROUGH_EXECUTOR =
  "Kysely transactions on the application database go through Kysely.transaction(), which the application executor runs";

class GatedDriver implements Driver {
  constructor(private readonly connection: DatabaseConnection) {}

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return this.connection;
  }

  async beginTransaction(): Promise<void> {
    throw new Error(TRANSACTIONS_THROUGH_EXECUTOR);
  }

  async commitTransaction(): Promise<void> {
    throw new Error(TRANSACTIONS_THROUGH_EXECUTOR);
  }

  async rollbackTransaction(): Promise<void> {
    throw new Error(TRANSACTIONS_THROUGH_EXECUTOR);
  }

  async releaseConnection(): Promise<void> {}

  /** The connections are the application's: never closed from here. */
  async destroy(): Promise<void> {}
}

class GatedDialect implements Dialect {
  constructor(
    private readonly executor: GatedExecutor,
    private readonly on: AppTx | undefined
  ) {}

  createDriver(): Driver {
    const executor = this.executor;
    return new GatedDriver(
      isPostgresExecutor(executor)
        ? new GatedPostgresConnection(executor, this.on)
        : new GatedSqliteConnection(executor, this.on)
    );
  }

  createQueryCompiler(): QueryCompiler {
    return isPostgresExecutor(this.executor) ? new PostgresQueryCompiler() : new SqliteQueryCompiler();
  }

  createAdapter(): DialectAdapter {
    return isPostgresExecutor(this.executor) ? new PostgresAdapter() : new SqliteAdapter();
  }

  createIntrospector(db: Kysely<AuthTables>): DatabaseIntrospector {
    return isPostgresExecutor(this.executor) ? new PostgresIntrospector(db) : new SqliteIntrospector(db);
  }
}

/** Better Auth's tables, untyped (Better Auth builds its queries from its own schema). */
type AuthTables = Record<string, Record<string, unknown>>;

/**
 * Kysely.transaction() runs as an application transaction: on SQLite the
 * gate and BEGIN, on PostgreSQL a pooled connection, BEGIN and the write
 * lock (either way a savepoint inside an open transaction), and the ambient
 * context in which the application's queries join it. The callback gets a
 * Kysely instance bound to that transaction.
 */
class GatedTransactionBuilder<DB> {
  private readOnly = false;

  constructor(
    private readonly executor: GatedExecutor,
    private readonly on: AppTx | undefined,
    private readonly plugins: readonly KyselyPlugin[]
  ) {}

  setAccessMode(accessMode: AccessMode): this {
    this.readOnly = accessMode === "read only";
    return this;
  }

  /** Application transactions have their own isolation (src/lib/db/README.md). */
  setIsolationLevel(): this {
    return this;
  }

  execute<T>(callback: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    const { executor, plugins } = this;
    const run = (tx: AppTx) => callback(new GatedKysely<DB>(executor, tx, plugins) as unknown as Transaction<DB>);
    const options = { readOnly: this.readOnly };
    // One call per executor type: TypeScript does not call a generic method on the union.
    return isPostgresExecutor(executor)
      ? executor.transaction(executor.frameOf(this.on), run, options)
      : executor.transaction(executor.frameOf(this.on), run, options);
  }
}

/**
 * Kysely over the application executor. Its queries run where the
 * executor's would: in the transaction it is bound to (`on`, the instance a
 * transaction callback gets), else in the calling context's transaction,
 * else on their own.
 */
export class GatedKysely<DB> extends Kysely<DB> {
  readonly #executor: GatedExecutor;
  readonly #on: AppTx | undefined;
  readonly #plugins: readonly KyselyPlugin[];

  constructor(executor: GatedExecutor, on?: AppTx, plugins: readonly KyselyPlugin[] = []) {
    super({ dialect: new GatedDialect(executor, on), plugins: [...plugins] });
    this.#executor = executor;
    this.#on = on;
    this.#plugins = plugins;
  }

  override transaction(): TransactionBuilder<DB> {
    return new GatedTransactionBuilder<DB>(this.#executor, this.#on, this.#plugins) as unknown as TransactionBuilder<DB>;
  }
}

/** The `database` option of betterAuth(): Kysely over the application executor. */
export type AuthDatabase = { db: GatedKysely<AuthTables>; type: "sqlite" | "postgres"; transaction: true };

/**
 * Better Auth's tables as getAuthTables(options) (better-auth/db) returns
 * them, as far as the PostgreSQL connection needs them.
 */
export type AuthSchema = Readonly<
  Record<string, { modelName: string; fields: Readonly<Record<string, { type: unknown; fieldName?: string }>> }>
>;

/** The date columns of Better Auth's tables (its fields of type "date"), by table. */
export function authDateColumns(schema: AuthSchema): DateColumns {
  const columns = new Map<string, Set<string>>();
  for (const table of Object.values(schema)) {
    for (const [key, field] of Object.entries(table.fields)) {
      if (field.type !== "date") continue;
      let set = columns.get(table.modelName);
      if (!set) columns.set(table.modelName, (set = new Set()));
      set.add(field.fieldName || key);
    }
  }
  return columns;
}

/** A stable key for `columns` (the same date columns give the same database). */
function dateColumnsKey(columns: DateColumns): string {
  const entries = [...columns].map(([table, set]) => [table, [...set].sort()] as const);
  return JSON.stringify(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const sqliteAuthDatabases = new WeakMap<SqliteExecutor, AuthDatabase>();
const postgresAuthDatabases = new WeakMap<PostgresExecutor, Map<string, AuthDatabase>>();

/**
 * Kysely over `executor` (tests: a test database's executor). On
 * PostgreSQL, the date fields of `schema` (Better Auth's) are read back as
 * Dates; SQLite ignores it.
 */
export function createAuthDatabase(executor: GatedExecutor, schema: AuthSchema = {}): AuthDatabase {
  // `transaction: true`: Better Auth wraps multi-statement operations in
  // transactions, as it did with the bun:sqlite connection.
  if (isPostgresExecutor(executor)) {
    const plugins = [new IsoDatesPlugin(authDateColumns(schema))];
    return { db: new GatedKysely<AuthTables>(executor, undefined, plugins), type: "postgres", transaction: true };
  }
  return { db: new GatedKysely<AuthTables>(executor), type: "sqlite", transaction: true };
}

/**
 * Better Auth's database: the application database through its executor,
 * one per executor (and, on PostgreSQL, per set of date columns). `schema`
 * is Better Auth's own (getAuthTables(options)): on PostgreSQL its date
 * fields are read back as Dates; SQLite ignores it (Better Auth reads the
 * text itself there).
 */
export function getAuthDatabase(schema: AuthSchema = {}): AuthDatabase {
  // getAppExecutor() is the configured dialect's executor.
  const executor = getAppExecutor();
  if (isPostgresExecutor(executor)) {
    let databases = postgresAuthDatabases.get(executor);
    if (!databases) postgresAuthDatabases.set(executor, (databases = new Map()));
    const key = dateColumnsKey(authDateColumns(schema));
    let database = databases.get(key);
    if (!database) {
      database = createAuthDatabase(executor, schema);
      databases.set(key, database);
    }
    return database;
  }
  let database = sqliteAuthDatabases.get(executor);
  if (!database) {
    database = createAuthDatabase(executor);
    sqliteAuthDatabases.set(executor, database);
  }
  return database;
}
