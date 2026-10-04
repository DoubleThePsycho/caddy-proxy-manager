/**
 * schema.pg.ts (generated) declares the same tables as schema.sqlite.ts:
 * per table the same columns with the same nullability and defaults, the same
 * primary keys and the same indexes. The only intended differences are the
 * column types (booleans, identity keys, int4/int8 per pg-column-types.ts),
 * ifnull() written as coalesce(), and no foreign keys.
 */
import { describe, expect, it } from 'vitest';
import { Column, SQL, StringChunk, getTableColumns, is } from 'drizzle-orm';
import { PgTable, getTableConfig as pgTableConfig } from 'drizzle-orm/pg-core';
import { SQLiteTable, getTableConfig as sqliteTableConfig, type SQLiteColumn } from 'drizzle-orm/sqlite-core';
import * as sqliteSchema from '../../src/lib/db/schema.sqlite';
import * as pgSchema from '../../src/lib/db/schema.pg';
import { pgIntegerType } from '../../src/lib/db/pg-column-types';

function renderSql(value: SQL): string {
  return value.queryChunks
    .map((chunk) => {
      if (is(chunk, StringChunk)) return chunk.value.join('');
      if (is(chunk, Column)) return `"${chunk.name}"`;
      if (is(chunk, SQL)) return renderSql(chunk);
      throw new Error(`unexpected SQL chunk ${String(chunk)}`);
    })
    .join('');
}

/** SQL compared across dialects: ifnull() is coalesce() on PostgreSQL. */
function comparableSql(value: SQL): string {
  return renderSql(value).replace(/\bifnull\s*\(/gi, 'coalesce(').replace(/\s+/g, ' ').trim();
}

function indexColumn(column: unknown): string {
  if (is(column, SQL)) return comparableSql(column);
  return (column as { name: string }).name;
}

function comparableDefault(value: unknown): unknown {
  return is(value, SQL) ? comparableSql(value) : value;
}

const sqliteTables = (Object.entries(sqliteSchema) as [string, unknown][]).filter(
  (entry): entry is [string, SQLiteTable] => is(entry[1], SQLiteTable)
);
const pgTables = (Object.entries(pgSchema) as [string, unknown][]).filter(
  (entry): entry is [string, PgTable] => is(entry[1], PgTable)
);

describe('schema.pg.ts parity with schema.sqlite.ts', () => {
  it('exports the same tables under the same names', () => {
    expect(pgTables.map(([name]) => name)).toEqual(sqliteTables.map(([name]) => name));
    expect(Object.keys(pgSchema).sort()).toEqual(Object.keys(sqliteSchema).sort());
    expect(sqliteTables.length).toBeGreaterThan(80);
  });

  describe.each(sqliteTables)('%s', (exportName, sqliteTable) => {
    const pgTable = (pgSchema as unknown as Record<string, PgTable>)[exportName];
    const sqlite = sqliteTableConfig(sqliteTable);
    const pg = pgTableConfig(pgTable);

    it('has the same name and columns', () => {
      expect(pg.name).toBe(sqlite.name);
      expect(Object.keys(getTableColumns(pgTable))).toEqual(Object.keys(getTableColumns(sqliteTable)));
      const shape = (column: { name: string; notNull: boolean; hasDefault: boolean; default: unknown; primary: boolean; isUnique: boolean }) => ({
        name: column.name,
        notNull: column.notNull,
        hasDefault: column.hasDefault,
        default: comparableDefault(column.default),
        primary: column.primary,
        isUnique: column.isUnique,
      });
      // SQLite gives an INTEGER PRIMARY KEY without AUTOINCREMENT the next
      // rowid when an insert leaves it out. These keys hold another row's id
      // (user_preferences.userId, fleet_instances.instanceId, ...) and are
      // always written explicitly; PostgreSQL gives them no default, so an
      // insert that leaves one out fails there instead of inventing an id.
      const rowidKey = (column: SQLiteColumn) =>
        column.columnType === 'SQLiteInteger' && column.primary && !(column as unknown as { autoIncrement: boolean }).autoIncrement;
      expect(pg.columns.map(shape)).toEqual(
        sqlite.columns.map((column) => ({ ...shape(column), hasDefault: rowidKey(column) ? false : column.hasDefault }))
      );
    });

    it('maps every column type', () => {
      for (const [key, sqliteColumn] of Object.entries(getTableColumns(sqliteTable))) {
        const pgColumn = getTableColumns(pgTable)[key];
        const where = `${sqlite.name}.${sqliteColumn.name}`;
        const identity = (pgColumn as unknown as { generatedIdentity?: { type: string } }).generatedIdentity;
        switch (sqliteColumn.columnType) {
          case 'SQLiteText':
            expect(pgColumn.columnType, where).toBe('PgText');
            break;
          case 'SQLiteBoolean':
            expect(pgColumn.columnType, where).toBe('PgBoolean');
            break;
          case 'SQLiteInteger': {
            const width = pgIntegerType(sqlite.name, sqliteColumn.name);
            expect(pgColumn.columnType, where).toBe(width === 'int8' ? 'PgBigInt53' : 'PgInteger');
            const autoIncrement = (sqliteColumn as unknown as { autoIncrement: boolean }).autoIncrement;
            expect(identity?.type, where).toBe(autoIncrement ? 'byDefault' : undefined);
            break;
          }
          default:
            throw new Error(`${where}: no PostgreSQL mapping for ${sqliteColumn.columnType}`);
        }
        if (sqliteColumn.columnType !== 'SQLiteInteger') expect(identity, where).toBeUndefined();
      }
    });

    it('has the same primary keys, unique constraints and checks', () => {
      const keys = (columns: { name: string }[]) => columns.map((column) => column.name);
      expect(pg.primaryKeys.map((key) => keys(key.columns))).toEqual(sqlite.primaryKeys.map((key) => keys(key.columns)));
      expect(pg.uniqueConstraints.map((unique) => [unique.getName(), keys(unique.columns)])).toEqual(
        sqlite.uniqueConstraints.map((unique) => [unique.getName(), keys(unique.columns)])
      );
      expect(pg.checks.map((check) => check.name)).toEqual(sqlite.checks.map((check) => check.name));
    });

    it('has the same indexes', () => {
      const pgIndexes = pg.indexes.map(({ config }) => ({
        name: config.name,
        unique: config.unique,
        columns: config.columns.map(indexColumn),
        where: config.where ? comparableSql(config.where) : null,
      }));
      const sqliteIndexes = sqlite.indexes.map(({ config }) => ({
        name: config.name,
        unique: config.unique,
        columns: config.columns.map(indexColumn),
        where: config.where ? comparableSql(config.where) : null,
      }));
      expect(pgIndexes).toEqual(sqliteIndexes);
    });

    it('declares no foreign keys on PostgreSQL', () => {
      expect(pg.foreignKeys).toEqual([]);
    });
  });
});
