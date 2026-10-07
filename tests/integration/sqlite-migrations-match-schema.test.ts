/**
 * The hand-written SQLite migrations (drizzle/) build the database that
 * schema.sqlite.ts describes: after migrating an empty database, every table,
 * column (type affinity, NOT NULL, default, primary key, AUTOINCREMENT) and
 * index matches the schema. Triggers and CHECK constraints live only in the
 * migrations and are not compared. Differences that already shipped are
 * listed in KNOWN_DRIFT with what they mean; a new difference fails the test,
 * and so does a fixed one until it is removed from the list.
 */
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Column, SQL, StringChunk, is } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { SQLiteTable, getTableConfig, type SQLiteColumn } from 'drizzle-orm/sqlite-core';
import * as sqliteSchema from '../../src/lib/db/schema.sqlite';

/**
 * Differences between the migrated database and schema.sqlite.ts that are
 * known and accepted. None today: users.provider/subject declare the DEFAULT ''
 * of 0022_nullable_provider_subject, and the schema declares the index of
 * 0007_linking_tokens, so the PostgreSQL baseline
 * (drizzle-pg/), built from the schema, matches a SQLite install.
 */
const KNOWN_DRIFT: string[] = [];

type TableInfo = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
type IndexList = { name: string; unique: number; origin: string; partial: number };

function migratedDatabase(): Database.Database {
  const client = new Database(':memory:');
  migrate(drizzle(client), { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  return client;
}

function renderSql(value: SQL): string {
  return value.queryChunks
    .map((chunk) => {
      if (is(chunk, StringChunk)) return chunk.value.join('');
      if (is(chunk, Column)) return chunk.name;
      if (is(chunk, SQL)) return renderSql(chunk);
      throw new Error(`unexpected SQL chunk ${String(chunk)}`);
    })
    .join('');
}

/** An index column or expression, compared without quotes, spaces or case. */
function normalizeExpression(text: string): string {
  return text.replace(/["`[\]\s]/g, '').toLowerCase();
}

/** The comma-separated items inside the first parenthesis after ON <table> of a CREATE INDEX. */
function indexedExpressions(createIndex: string): string[] {
  const on = /\bON\s+["`[]?\w+["`\]]?\s*\(/i.exec(createIndex);
  if (!on) throw new Error(`cannot read ${createIndex}`);
  const items: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of createIndex.slice(on.index + on[0].length)) {
    if (char === '(') depth++;
    if (char === ')' && depth-- === 0) break;
    if (char === ',' && depth === 0) {
      items.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  items.push(current);
  return items.map(normalizeExpression);
}

/** A column default as SQLite reports it (PRAGMA table_info dflt_value), as a JavaScript value. */
function parseDefault(value: string | null): unknown {
  if (value === null) return null;
  let text = value.trim();
  while (text.startsWith('(') && text.endsWith(')')) text = text.slice(1, -1).trim();
  if (/^'.*'$/s.test(text)) return text.slice(1, -1).replace(/''/g, "'");
  if (/^true$/i.test(text)) return 1;
  if (/^false$/i.test(text)) return 0;
  if (/^null$/i.test(text)) return null;
  if (/^[-+]?\d+(\.\d+)?$/.test(text)) return Number(text);
  return `expression ${text}`;
}

function schemaDefault(column: SQLiteColumn): unknown {
  const value = column.default;
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (is(value, SQL)) return `expression ${renderSql(value)}`;
  return value;
}

function affinity(type: string): string {
  return (/^\s*(\w+)/.exec(type)?.[1] ?? '').toLowerCase();
}

function schemaDrift(client: Database.Database): string[] {
  const drift: string[] = [];
  const tables = (Object.values(sqliteSchema) as unknown[]).filter((value): value is SQLiteTable => is(value, SQLiteTable));
  const master = client
    .prepare("SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .all() as { type: string; name: string; tableName: string; sql: string | null }[];
  const databaseTables = new Set(master.filter((row) => row.type === 'table').map((row) => row.name));
  const schemaTables = new Set(tables.map((table) => getTableConfig(table).name));

  for (const name of [...databaseTables].sort()) {
    if (name !== '__drizzle_migrations' && !schemaTables.has(name)) drift.push(`table ${name}: in the database only`);
  }

  for (const table of tables) {
    const config = getTableConfig(table);
    const t = config.name;
    if (!databaseTables.has(t)) {
      drift.push(`table ${t}: missing from the database`);
      continue;
    }
    const info = client.prepare(`PRAGMA table_info("${t}")`).all() as TableInfo[];
    const byName = new Map(info.map((row) => [row.name, row]));
    const compositeKey = new Set(config.primaryKeys.flatMap((key) => key.columns.map((column) => column.name)));

    for (const column of config.columns) {
      const where = `${t}.${column.name}`;
      const row = byName.get(column.name);
      if (!row) {
        drift.push(`${where}: missing from the database`);
        continue;
      }
      const schemaType = affinity(column.getSQLType());
      if (affinity(row.type) !== schemaType) drift.push(`${where}: type ${row.type} in the database, ${column.getSQLType()} in the schema`);
      const primary = column.primary || compositeKey.has(column.name);
      if ((row.pk > 0) !== primary) drift.push(`${where}: primary key ${row.pk > 0} in the database, ${primary} in the schema`);
      // An INTEGER PRIMARY KEY is the rowid and can never be null; any other
      // primary key column accepts NULL in SQLite unless declared NOT NULL.
      const rowid = row.pk > 0 && affinity(row.type) === 'integer' && info.filter((r) => r.pk > 0).length === 1;
      const notNull = row.notnull === 1 || rowid;
      if (notNull !== column.notNull) drift.push(`${where}: NOT NULL ${notNull} in the database, ${column.notNull} in the schema`);
      const databaseDefault = parseDefault(row.dflt_value);
      const expectedDefault = schemaDefault(column);
      if (databaseDefault !== expectedDefault) {
        drift.push(`${where}: default ${JSON.stringify(databaseDefault)} in the database, ${JSON.stringify(expectedDefault)} in the schema`);
      }
    }
    for (const row of info) {
      if (!config.columns.some((column) => column.name === row.name)) drift.push(`${t}.${row.name}: in the database only`);
    }

    const createTable = master.find((row) => row.type === 'table' && row.name === t)?.sql ?? '';
    const autoIncrement = config.columns.some((column) => (column as unknown as { autoIncrement?: boolean }).autoIncrement);
    if (/\bAUTOINCREMENT\b/i.test(createTable) !== autoIncrement) {
      drift.push(`table ${t}: AUTOINCREMENT ${!autoIncrement ? 'in the database only' : 'missing from the database'}`);
    }

    const indexList = (client.prepare(`PRAGMA index_list("${t}")`).all() as IndexList[]).filter((row) => row.origin !== 'pk');
    for (const index of config.indexes) {
      const { name, unique, columns, where } = index.config;
      const row = indexList.find((candidate) => candidate.name === name);
      if (!row) {
        drift.push(`index ${name} on ${t}: missing from the database`);
        continue;
      }
      if ((row.unique === 1) !== unique) drift.push(`index ${name} on ${t}: unique ${row.unique === 1} in the database, ${unique} in the schema`);
      if ((row.partial === 1) !== !!where) drift.push(`index ${name} on ${t}: partial ${row.partial === 1} in the database, ${!!where} in the schema`);
      const createIndex = master.find((candidate) => candidate.type === 'index' && candidate.name === name)?.sql ?? '';
      const databaseColumns = indexedExpressions(createIndex);
      const schemaColumns = columns.map((column) => normalizeExpression(is(column, SQL) ? renderSql(column) : column.name));
      if (databaseColumns.join(',') !== schemaColumns.join(',')) {
        drift.push(`index ${name} on ${t}: (${databaseColumns.join(', ')}) in the database, (${schemaColumns.join(', ')}) in the schema`);
      }
    }
    for (const row of indexList) {
      if (config.indexes.some((index) => index.config.name === row.name)) continue;
      const columns = (client.prepare(`PRAGMA index_info("${row.name}")`).all() as { name: string | null }[])
        .map((column) => column.name ?? '<expression>')
        .join(', ');
      const kind = row.origin === 'u' ? 'UNIQUE constraint' : row.unique ? 'unique index' : 'index';
      const label = row.origin === 'u' ? '' : ` ${row.name}`;
      drift.push(`${kind}${label} on ${t} (${columns}): in the database only`);
    }
  }
  return drift;
}

describe('SQLite migrations match schema.sqlite.ts', () => {
  const client = migratedDatabase();
  const drift = schemaDrift(client);

  it('checks every table of the schema', () => {
    const tables = (Object.values(sqliteSchema) as unknown[]).filter((value) => is(value, SQLiteTable));
    expect(tables.length).toBeGreaterThan(80);
  });

  it('builds the tables, columns and indexes the schema declares', () => {
    expect(drift).toEqual(KNOWN_DRIFT);
  });

  it('notices a column, default, index or table the schema does not have', () => {
    const altered = migratedDatabase();
    altered.exec(`
      ALTER TABLE settings ADD COLUMN extra TEXT;
      DROP INDEX users_email_unique;
      CREATE TABLE stray (id INTEGER PRIMARY KEY);
      CREATE UNIQUE INDEX sessions_extra_unique ON sessions (userAgent, ipAddress);
    `);
    // Database-only tables first, then each table in schema order (users, sessions, ..., settings).
    expect(schemaDrift(altered).filter((entry) => !KNOWN_DRIFT.includes(entry))).toEqual([
      'table stray: in the database only',
      'index users_email_unique on users: missing from the database',
      'unique index sessions_extra_unique on sessions (userAgent, ipAddress): in the database only',
      'settings.extra: in the database only',
    ]);
  });
});
