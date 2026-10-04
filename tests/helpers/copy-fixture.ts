/**
 * Rows for every table of the schema, for the SQLite → PostgreSQL copy
 * (src/lib/db/copy/): its tests (tests/integration/pg/copy-sqlite-to-postgres.test.ts)
 * and its benchmark (scripts/db/copy-benchmark.ts). The rows come from the
 * copy's own table list, so a new table gets rows without a change here.
 *
 * Each table gets three rows with the values that are easy to get wrong:
 *   variant 0  the largest values: int4 2^31 - 1, int8 2^63 - 1, true, text
 *              with accents, CJK, an emoji, quotes and backslashes;
 *   variant 1  NULL wherever the column allows it, otherwise the smallest
 *              values (int4 -2^31, int8 -2^63, false, empty text);
 *   variant 2  ordinary values: JSON text, ISO dates, 2^53 + 1 (which a
 *              JavaScript number cannot hold) in int8 columns.
 * Identity keys are the row numbers. The schema's own rules hold: a
 * forward-auth grant names a user or a group, never both or neither.
 *
 * Works with better-sqlite3 (tests) and bun:sqlite (the benchmark): it only
 * prepares and runs statements. Foreign keys must be off (the application
 * runs with them off; better-sqlite3 turns them on by default).
 */
import { getTableColumns } from 'drizzle-orm';
import { copyTables, quoteIdentifier, type CopyColumn, type CopyTable } from '../../src/lib/db/copy/tables';

export interface FixtureSqlite {
  prepare(sql: string): { run(...params: unknown[]): unknown };
  exec(sql: string): unknown;
}

export type Variant = 0 | 1 | 2;

export const INT4_MAX = 2_147_483_647;
export const INT4_MIN = -2_147_483_648;
export const INT8_MAX = 9_223_372_036_854_775_807n;
export const INT8_MIN = -9_223_372_036_854_775_808n;
/** 2^53 + 1: exact as int8 text, not as a JavaScript number. */
export const INT8_PAST_DOUBLE = 9_007_199_254_740_993n;

/** Text with characters encodings and escaping get wrong. */
export const UNICODE_TEXT = 'Zürich – 東京 – 🚀 "quoted" \\back\\slash \'single\' tab\there';

/** ISO 8601 timestamps, by the schema's naming (createdAt, expiresAt, …). */
function isDateColumn(column: CopyColumn): boolean {
  return /At$/.test(column.name);
}

/** Whether `column` of `table` may be NULL (from the SQLite schema). */
function nullable(table: CopyTable, column: CopyColumn): boolean {
  const definition = Object.values(getTableColumns(table.sqliteTable)).find((candidate) => candidate.name === column.name);
  return !!definition && !definition.notNull && !definition.primary;
}

/** The value of `column` in row `row` (1, 2, 3, …) of variant `variant`. */
export function fixtureValue(table: CopyTable, column: CopyColumn, variant: Variant, row: number): unknown {
  const isKey = table.primaryKey.includes(column.name);
  if (column.name === table.identity) return row;
  if (variant === 1 && !isKey && nullable(table, column)) return null;
  switch (column.kind) {
    case 'int4':
      return variant === 0 ? INT4_MAX : variant === 1 ? INT4_MIN : 7 + row;
    case 'int8':
      return variant === 0 ? INT8_MAX : variant === 1 ? INT8_MIN : INT8_PAST_DOUBLE + BigInt(row);
    case 'boolean':
      return variant === 0 ? 1 : variant === 1 ? 0 : row % 2;
    case 'text':
      if (isKey) return variant === 1 ? '' : `${table.name}-${row}-ключ`;
      if (isDateColumn(column)) {
        if (variant === 0) return '9999-12-31T23:59:59.999Z';
        if (variant === 1) return '1970-01-01T00:00:00.000Z';
        return new Date(Date.UTC(2026, 9, 4, 12, 0, 0, row)).toISOString();
      }
      if (variant === 0) return `${UNICODE_TEXT} ${table.name}.${column.name}`;
      if (variant === 1) return '';
      return JSON.stringify({ table: table.name, column: column.name, row, list: [1, 2.5, 'ü', null, true], nested: { ok: false } });
  }
}

/** The values of row `row` of `table`, in column order. */
export function fixtureRow(table: CopyTable, variant: Variant, row: number): unknown[] {
  const values = table.columns.map((column) => fixtureValue(table, column, variant, row));
  if (table.name === 'forward_auth_access') {
    // CHECK: a user or a group, never both or neither.
    const userId = table.columns.findIndex((column) => column.name === 'userId');
    const groupId = table.columns.findIndex((column) => column.name === 'groupId');
    if (variant === 1) {
      values[userId] = null;
      values[groupId] = INT4_MIN;
    } else {
      values[groupId] = null;
    }
  }
  return values;
}

/** Inserts `rows` (values in column order) into `table`. */
export function insertRows(db: FixtureSqlite, table: CopyTable, rows: readonly unknown[][]): void {
  const columns = table.columns.map((column) => quoteIdentifier(column.name));
  const insert = db.prepare(
    `INSERT INTO ${quoteIdentifier(table.name)} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
  );
  for (const row of rows) insert.run(...row);
}

export interface PopulateOptions {
  /** Stored as oauth_providers.clientSecret of the third row: an encrypted value (enc:v1:…). */
  encryptedSecret?: string;
}

/**
 * Three rows in every table (see the module comment), and the cases the
 * copy must carry over exactly:
 * - a disabled user without disabledAt (accounts disabled before
 *   drizzle/0047), which PostgreSQL's insert trigger would fill in;
 * - an AUTOINCREMENT counter past the highest id (instances: a row with id
 *   50 was deleted), which the copied identity must not fall behind.
 */
export function populateEveryTable(db: FixtureSqlite, options: PopulateOptions = {}): void {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  for (const table of copyTables()) {
    const rows = ([0, 1, 2] as const).map((variant) => fixtureRow(table, variant, variant + 1));
    if (table.name === 'oauth_providers' && options.encryptedSecret) {
      rows[2][table.columns.findIndex((column) => column.name === 'clientSecret')] = options.encryptedSecret;
    }
    insertRows(db, table, rows);
  }
  const users = copyTables().find((table) => table.name === 'users')!;
  const disabled = fixtureRow(users, 2, 4);
  disabled[users.columns.findIndex((column) => column.name === 'status')] = 'disabled';
  insertRows(db, users, [disabled]);
  db.prepare('UPDATE "users" SET "disabledAt" = NULL WHERE "id" = 4').run();
  const instances = copyTables().find((table) => table.name === 'instances')!;
  insertRows(db, instances, [fixtureRow(instances, 2, 50)]);
  db.prepare('DELETE FROM "instances" WHERE "id" = 50').run();
  db.exec('COMMIT');
}

/** Appends `count` ordinary rows to `table`, numbered after `after`, in one transaction. */
export function appendRows(db: FixtureSqlite, table: CopyTable, count: number, after: number): void {
  db.exec('BEGIN');
  const columns = table.columns.map((column) => quoteIdentifier(column.name));
  const insert = db.prepare(
    `INSERT INTO ${quoteIdentifier(table.name)} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
  );
  for (let row = after + 1; row <= after + count; row++) insert.run(...fixtureRow(table, 2, row));
  db.exec('COMMIT');
}
