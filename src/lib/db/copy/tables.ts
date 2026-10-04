/**
 * What the SQLite → PostgreSQL copy (copy.ts) moves, generated from the
 * schema rather than listed by hand: every table of schema.sqlite.ts, paired
 * with its twin in schema.pg.ts, and each column's kind, which decides how a
 * value is written to PostgreSQL and how it is compared (verify.ts).
 *
 * A column kind the copy does not know (a new column type in the schema)
 * fails when the list is built, so it is handled on purpose rather than
 * copied wrongly; tests/unit/db-copy-tables.test.ts builds it.
 *
 * Values arrive from SQLite with integers as bigint (the source is opened
 * with safeIntegers), so 64-bit values are exact.
 */
import { createHash } from "node:crypto";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { getTableConfig as getPgTableConfig, PgTable } from "drizzle-orm/pg-core";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as pgSchema from "../schema.pg";
import * as sqliteSchema from "../schema.sqlite";

/** How a column is stored on PostgreSQL (src/lib/db/pg-column-types.ts decides int4 or int8). */
export type ColumnKind = "int4" | "int8" | "boolean" | "text";

/** The PostgreSQL type of each kind, for casts. */
export const PG_TYPE_OF_KIND: Readonly<Record<ColumnKind, string>> = {
  int4: "integer",
  int8: "bigint",
  boolean: "boolean",
  text: "text",
};

export interface CopyColumn {
  /** The column's name, the same in both databases. */
  readonly name: string;
  readonly kind: ColumnKind;
}

export interface CopyTable {
  readonly name: string;
  readonly sqliteTable: SQLiteTable;
  readonly pgTable: PgTable;
  /** In the order of the schema. */
  readonly columns: readonly CopyColumn[];
  /** The primary key's columns (row positions in error messages, ordering in tests). */
  readonly primaryKey: readonly string[];
  /** The identity column (an AUTOINCREMENT key on SQLite), whose sequence follows the copied ids. */
  readonly identity: string | null;
}

const PG_KINDS: Readonly<Record<string, ColumnKind>> = {
  PgInteger: "int4",
  PgBigInt53: "int8",
  PgBoolean: "boolean",
  PgText: "text",
};

/** The SQLite column types each kind may come from. */
const SQLITE_TYPES_OF_KIND: Readonly<Record<ColumnKind, readonly string[]>> = {
  int4: ["SQLiteInteger"],
  int8: ["SQLiteInteger"],
  boolean: ["SQLiteBoolean"],
  text: ["SQLiteText"],
};

function buildTable(exportName: string, sqliteTable: SQLiteTable): CopyTable {
  const name = getTableName(sqliteTable);
  const pgTable = (pgSchema as Record<string, unknown>)[exportName];
  if (!is(pgTable, PgTable) || getTableName(pgTable) !== name) {
    throw new Error(`schema.pg.ts has no table ${name} (export ${exportName}): run bun run db:generate-pg-schema`);
  }
  const sqliteColumns = getTableColumns(sqliteTable);
  const pgColumns = getTableColumns(pgTable);
  const keys = Object.keys(sqliteColumns);
  if (keys.join(",") !== Object.keys(pgColumns).join(",")) {
    throw new Error(`${name}: the SQLite and PostgreSQL schemas have different columns`);
  }
  const columns: CopyColumn[] = [];
  let identity: string | null = null;
  const primaryKey: string[] = [];
  for (const key of keys) {
    const sqliteColumn = sqliteColumns[key];
    const pgColumn = pgColumns[key];
    if (sqliteColumn.name !== pgColumn.name) {
      throw new Error(`${name}.${key}: named ${sqliteColumn.name} on SQLite and ${pgColumn.name} on PostgreSQL`);
    }
    const kind = PG_KINDS[pgColumn.columnType];
    if (!kind) {
      throw new Error(`${name}.${pgColumn.name}: the copy does not know the column type ${pgColumn.columnType}`);
    }
    if (!SQLITE_TYPES_OF_KIND[kind].includes(sqliteColumn.columnType)) {
      throw new Error(`${name}.${pgColumn.name}: ${sqliteColumn.columnType} on SQLite but ${pgColumn.columnType} on PostgreSQL`);
    }
    columns.push({ name: pgColumn.name, kind });
    if (pgColumn.primary) primaryKey.push(pgColumn.name);
    if (pgColumn.primary && (pgColumn as { generatedIdentity?: unknown }).generatedIdentity !== undefined) {
      identity = pgColumn.name;
    }
  }
  for (const key of getPgTableConfig(pgTable).primaryKeys) {
    for (const column of key.columns) if (!primaryKey.includes(column.name)) primaryKey.push(column.name);
  }
  return { name, sqliteTable, pgTable, columns, primaryKey, identity };
}

let cached: readonly CopyTable[] | undefined;

/**
 * Every table of the schema, by name (the order of a module's exports
 * differs between runtimes and bundlers; PostgreSQL has no foreign keys, so
 * any order works).
 */
export function copyTables(): readonly CopyTable[] {
  if (!cached) {
    const tables: CopyTable[] = [];
    for (const [exportName, value] of Object.entries(sqliteSchema)) {
      if (is(value, SQLiteTable)) tables.push(buildTable(exportName, value));
    }
    tables.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    const duplicate = tables.find((table, index) => index > 0 && tables[index - 1].name === table.name);
    if (duplicate) throw new Error(`schema.sqlite.ts declares the table ${duplicate.name} twice`);
    cached = tables;
  }
  return cached;
}

/** A quoted SQL identifier (both dialects). */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// ── Values ──

/** A value as SQLite returns it with safeIntegers on. */
export type SqliteValue = null | undefined | bigint | number | string | Uint8Array;

/** A value as the copy sends it to PostgreSQL (int8 as decimal text, so it stays exact). */
export type PgValue = null | number | string | boolean;

const INT4_MIN = -2_147_483_648n;
const INT4_MAX = 2_147_483_647n;
const INT8_MIN = -9_223_372_036_854_775_808n;
const INT8_MAX = 9_223_372_036_854_775_807n;

/** A value the copy cannot store; `problem` describes it without the value itself (it may be a secret). */
export class UnsupportedValueError extends Error {
  constructor(readonly problem: string) {
    super(problem);
    this.name = "UnsupportedValueError";
  }
}

function describeType(value: SqliteValue): string {
  if (value instanceof Uint8Array) return "binary data";
  if (typeof value === "number") return "a decimal number";
  if (typeof value === "string") return "text";
  return typeof value;
}

/** An integer read from SQLite as bigint (or as a number holding an integer). */
function integerOf(value: SqliteValue): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  return null;
}

/**
 * The value PostgreSQL stores for `value` in a column of `kind`, as SQLite
 * holds it. Throws UnsupportedValueError for a value PostgreSQL cannot hold
 * exactly: an integer column holding text, a decimal number or one out of
 * range, a boolean other than 0 or 1, text with a NUL character, binary data.
 */
export function toPostgresValue(kind: ColumnKind, value: SqliteValue): PgValue {
  if (value === null || value === undefined) return null;
  switch (kind) {
    case "int4":
    case "int8": {
      const integer = integerOf(value);
      if (integer === null) throw new UnsupportedValueError(`holds ${describeType(value)} where an integer belongs`);
      const [min, max] = kind === "int4" ? [INT4_MIN, INT4_MAX] : [INT8_MIN, INT8_MAX];
      if (integer < min || integer > max) {
        throw new UnsupportedValueError(
          `holds ${integer}, outside the range of a PostgreSQL ${PG_TYPE_OF_KIND[kind]} (${min} to ${max})`
        );
      }
      return kind === "int4" ? Number(integer) : integer.toString();
    }
    case "boolean": {
      const integer = integerOf(value);
      if (integer === 1n) return true;
      if (integer === 0n) return false;
      throw new UnsupportedValueError(
        integer === null ? `holds ${describeType(value)} where a boolean (0 or 1) belongs` : `holds ${integer} where a boolean (0 or 1) belongs`
      );
    }
    case "text": {
      if (typeof value !== "string") throw new UnsupportedValueError(`holds ${describeType(value)} where text belongs`);
      if (value.includes("\u0000")) throw new UnsupportedValueError("holds text with a NUL character, which PostgreSQL cannot store");
      return value;
    }
  }
}

// ── Checksums (verify.ts) ──

/**
 * A value as the checksums compare it, the same on both sides: integers as
 * decimal text, booleans as "true"/"false", text as it is, NULL as null.
 * Anything else SQLite may hold gets a prefix, so it never equals a value
 * PostgreSQL returns.
 */
export function sqliteToken(kind: ColumnKind, value: SqliteValue): string | null {
  if (value === null || value === undefined) return null;
  const integer = integerOf(value);
  if (kind === "text") {
    if (typeof value === "string") return value;
    return integer !== null ? `\u0000integer:${integer}` : `\u0000${describeType(value)}:${String(value)}`;
  }
  if (integer === null) {
    if (value instanceof Uint8Array) return `\u0000binary:${Buffer.from(value).toString("hex")}`;
    return `\u0000${describeType(value)}:${String(value)}`;
  }
  if (kind === "boolean") return integer === 1n ? "true" : integer === 0n ? "false" : `\u0000integer:${integer}`;
  return integer.toString();
}

/** A value PostgreSQL returned as text (the column cast to text), as the checksums compare it. */
export function postgresToken(value: string | null | undefined): string | null {
  return value ?? null;
}

const CHECKSUM_MODULUS = 1n << 256n;

/**
 * The rows of a table as a count and a checksum: the sum, modulo 2^256, of
 * the SHA-256 of each row's tokens. A sum does not depend on the order the
 * rows are read in, so neither side has to sort them.
 */
export class TableDigest {
  rows = 0;
  private sum = 0n;

  add(tokens: readonly (string | null)[]): void {
    const digest = createHash("sha256").update(JSON.stringify(tokens)).digest("hex");
    this.sum = (this.sum + BigInt(`0x${digest}`)) % CHECKSUM_MODULUS;
    this.rows += 1;
  }

  get checksum(): string {
    return this.sum.toString(16).padStart(64, "0");
  }
}
