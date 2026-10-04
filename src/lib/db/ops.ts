/**
 * Query helpers whose SQL differs between SQLite and PostgreSQL
 * (src/lib/db/README.md). Code outside src/lib/db uses these instead of
 * dialect-specific SQL, raw driver calls or driver error codes.
 *
 * The dialect is read when a helper is called (getDialect()), so the SQL a
 * helper returns is for the database the application runs on.
 */
import {
  asc as drizzleAsc,
  desc as drizzleDesc,
  getTableColumns,
  getTableName,
  sql,
  type AnyColumn,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { isPostgres } from "./dialect";
import { resolveDbTarget } from "./executor";
import { openFrame, transactionContext } from "./executor-core";
import type { DbExecutor } from "./types";

type Expression = AnyColumn | SQLWrapper;

// ── Reading ──

/**
 * The first row of `query`, or undefined: what `.get()` returned. Add
 * `.limit(1)` to the query when its filter can match several rows.
 */
export async function first<T>(query: PromiseLike<readonly T[]>): Promise<T | undefined> {
  const rows = await query;
  return rows[0];
}

// ── Ordering ──

export type NullsOrder = "first" | "last";

/**
 * Ascending order with NULLs first by default, as SQLite sorts them
 * (PostgreSQL puts them last unless told).
 */
export function asc(column: Expression, options: { nulls?: NullsOrder } = {}): SQL {
  const nulls = options.nulls ?? "first";
  if (isPostgres()) return nulls === "first" ? sql`${column} asc nulls first` : sql`${column} asc nulls last`;
  return nulls === "first" ? drizzleAsc(column) : sql`${column} asc nulls last`;
}

/**
 * Descending order with NULLs last by default, as SQLite sorts them
 * (PostgreSQL puts them first unless told).
 */
export function desc(column: Expression, options: { nulls?: NullsOrder } = {}): SQL {
  const nulls = options.nulls ?? "last";
  if (isPostgres()) return nulls === "last" ? sql`${column} desc nulls last` : sql`${column} desc nulls first`;
  return nulls === "last" ? drizzleDesc(column) : sql`${column} desc nulls first`;
}

// ── Text matching ──

/** Escapes LIKE's wildcards (% and _) and the escape character (\) in `text`. */
export function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * `column` matches the LIKE `pattern` (% any text, _ one character, \ escapes
 * them), ignoring the case of ASCII letters as SQLite's LIKE does.
 */
export function likeText(column: Expression, pattern: string): SQL {
  // ILIKE folds ASCII letters only in a database with the C character
  // classification, which start-up requires (startup.ts).
  if (isPostgres()) return sql`${column} ilike ${pattern} escape '\\'`;
  return sql`${column} like ${pattern} escape '\\'`;
}

/** `column` contains `text` literally, ignoring the case of ASCII letters. */
export function containsText(column: Expression, text: string): SQL {
  return likeText(column, `%${escapeLikePattern(text)}%`);
}

/**
 * lower(`column`) = `value`. SQL lower() folds ASCII letters only (on both
 * dialects), so `value` must already be lowercase; it is not lowered here.
 */
export function lowerEquals(column: Expression, value: string): SQL {
  return sql`lower(${column}) = ${value}`;
}

// ── JSON stored as text ──

/**
 * The JSON array stored as text in `column` holds at least one of `values`.
 * Invalid JSON matches nothing, and so do no values.
 */
export function jsonArrayIncludesAny(column: Expression, values: readonly string[]): SQL {
  if (values.length === 0) return sqlFalse();
  const list = sql.join(
    values.map((value) => sql`${value}`),
    sql`, `
  );
  if (isPostgres()) {
    // IS JSON ARRAY (PostgreSQL 16): text that is not a JSON array matches nothing.
    return sql`exists (select 1 from jsonb_array_elements_text(case when ${column} is json array then (${column})::jsonb else '[]'::jsonb end) as json_element(value) where json_element.value in (${list}))`;
  }
  return sql`exists (select 1 from json_each(case when json_valid(${column}) then ${column} else '[]' end) where json_each.value in (${list}))`;
}

const JSON_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The value at `path` (object keys and array indexes) in the JSON stored as
 * text in `column`, as text; NULL when the JSON is invalid or has nothing
 * there.
 */
export function jsonTextAt(column: Expression, path: readonly (string | number)[]): SQL {
  if (path.length === 0) throw new Error("jsonTextAt needs a path");
  const jsonPath = path
    .map((segment) => {
      if (typeof segment === "number") {
        if (!Number.isInteger(segment) || segment < 0) throw new Error(`Invalid JSON array index ${segment}`);
        return `[${segment}]`;
      }
      if (!JSON_KEY.test(segment)) throw new Error(`Invalid JSON key ${JSON.stringify(segment)}`);
      return `.${segment}`;
    })
    .join("");
  if (isPostgres()) {
    // The segments are checked above, so the text[] literal needs no quoting.
    const pgPath = `{${path.join(",")}}`;
    return sql`case when ${column} is json then (${column})::jsonb #>> ${pgPath}::text[] end`;
  }
  return sql`case when json_valid(${column}) then cast(json_extract(${column}, ${`$${jsonPath}`}) as text) end`;
}

// ── Literals ──

/** A condition that is always false (an empty filter that must match nothing). */
export function sqlFalse(): SQL {
  return isPostgres() ? sql`false` : sql`0`;
}

/** A condition that is always true. */
export function sqlTrue(): SQL {
  return isPostgres() ? sql`true` : sql`1`;
}

// ── Errors ──

/** The error and its causes (Drizzle wraps driver errors in DrizzleQueryError). */
function errorChain(error: unknown): Array<{ code?: unknown; message: string }> {
  const chain: Array<{ code?: unknown; message: string }> = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
    const { code, message, cause } = current as { code?: unknown; message?: unknown; cause?: unknown };
    chain.push({ code, message: typeof message === "string" ? message : "" });
    current = cause;
  }
  return chain;
}

/**
 * A UNIQUE or PRIMARY KEY violation (SQLite SQLITE_CONSTRAINT_UNIQUE /
 * _PRIMARYKEY, PostgreSQL 23505).
 */
export function isUniqueViolation(error: unknown): boolean {
  return errorChain(error).some(({ code, message }) =>
    code === "SQLITE_CONSTRAINT_UNIQUE"
    || code === "SQLITE_CONSTRAINT_PRIMARYKEY"
    || code === "23505"
    || /UNIQUE constraint failed/i.test(message)
  );
}

/**
 * Any integrity constraint violation: UNIQUE, NOT NULL, CHECK, FOREIGN KEY or
 * a trigger's refusal (SQLite SQLITE_CONSTRAINT*, PostgreSQL class 23).
 */
export function isConstraintViolation(error: unknown): boolean {
  return errorChain(error).some(({ code, message }) =>
    (typeof code === "string" && (code.startsWith("SQLITE_CONSTRAINT") || /^23[0-9A-Z]{3}$/.test(code)))
    || /constraint failed/i.test(message)
  );
}

/**
 * A write refused because the database or transaction is read-only (SQLite
 * SQLITE_READONLY*, PostgreSQL 25006).
 */
export function isReadOnlyError(error: unknown): boolean {
  return errorChain(error).some(({ code, message }) =>
    (typeof code === "string" && (code.startsWith("SQLITE_READONLY") || code === "25006"))
    || /readonly database/i.test(message)
  );
}

// ── Identity columns ──

/**
 * After rows were inserted with explicit ids, makes the next generated id
 * follow them. SQLite's AUTOINCREMENT already does; on PostgreSQL the
 * identity sequence of the table's primary key is moved past the highest id,
 * in `db`'s transaction (or the calling context's). As with AUTOINCREMENT
 * the sequence never moves back: an id handed out before (to a row deleted
 * since, say by a configuration restore) is not handed out again. A table
 * without an identity column is left alone.
 */
export async function resyncIdentity(table: SQLiteTable, db?: DbExecutor): Promise<void> {
  if (!isPostgres()) return;
  // On PostgreSQL the tables are pg-core tables: identity columns carry generatedIdentity.
  const key = Object.values(getTableColumns(table)).find(
    (column) => column.primary && (column as { generatedIdentity?: unknown }).generatedIdentity !== undefined
  );
  if (!key) return;
  const tableName = getTableName(table);
  // pg_get_serial_sequence reads its first argument as a (quoted) table
  // name and its second as a plain column name. pg_sequence_last_value is
  // the last id handed out (null when none was, or after a restart). A new
  // sequence on an empty table is left as it is: setval cannot go below 1.
  await execRaw(
    sql`select setval(identity.seq, greatest(coalesce(highest.id, 0), coalesce(pg_sequence_last_value(identity.seq), 0)), true)
      from (select pg_get_serial_sequence(${`"${tableName.replace(/"/g, '""')}"`}, ${key.name})::regclass as seq) as identity,
        (select max(${sql.identifier(key.name)}) as id from ${sql.identifier(tableName)}) as highest
      where highest.id is not null or pg_sequence_last_value(identity.seq) is not null`,
    db
  );
}

// ── Transactions ──

/**
 * Runs `fn`, whose failure the caller catches and carries on from, so that
 * the failure does not end the caller's transaction: inside a transaction in
 * a savepoint of its own (a nested transaction), outside one as it is. On
 * PostgreSQL a failed statement aborts the whole transaction it runs in, and
 * a writing transaction that caught the error and went on ends in
 * TransactionAbortedError instead of committing.
 */
export async function recoverable<T>(fn: () => Promise<T>): Promise<T> {
  const frame = transactionContext.getStore();
  const open = frame ? openFrame(frame) : null;
  if (!open) return await fn();
  return await open.tx.transaction(async () => await fn());
}

// ── Raw SQL ──

/**
 * Runs one raw statement and returns its rows as objects keyed by column
 * name (none for a statement that returns no rows). It runs in `db`'s
 * transaction (a tx object), or in the calling context's, or through the
 * gate; `db` defaults to the application database.
 */
export async function execRaw<T = Record<string, unknown>>(query: SQL | string, db?: DbExecutor): Promise<T[]> {
  const { executor } = resolveDbTarget(db);
  const compiled = typeof query === "string" ? { sql: query, params: [] as unknown[] } : executor.compile(query);
  const result = await executor.query(compiled.sql, compiled.params, db);
  return result.rows as T[];
}
