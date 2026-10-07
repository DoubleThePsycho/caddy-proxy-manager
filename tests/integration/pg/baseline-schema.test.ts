/**
 * The PostgreSQL migrations (drizzle-pg/) build the database that
 * schema.pg.ts describes: after migrating an empty database, every table,
 * column (type, NOT NULL, default, identity), primary key, unique constraint
 * and index matches the schema, and there are no foreign keys (SQLite does not
 * enforce its own). The only objects the schema does not declare are the ones
 * the baseline adds on purpose, as the SQLite migrations do: the
 * forward_auth_access CHECK and the users triggers. Runs against a real
 * server; skipped without TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Client } from 'pg';
import { Column, SQL, StringChunk, is } from 'drizzle-orm';
import { PgTable, getTableConfig, type PgColumn } from 'drizzle-orm/pg-core';
import * as pgSchema from '../../../src/lib/db/schema.pg';
import {
  PG_MIGRATIONS_FOLDER,
  TEST_DATABASE_URL,
  createPgTestDatabase,
  migratePgDatabase,
  type PgTestDatabase,
} from '../../helpers/pg-database';

/** CHECK constraints the baseline adds (drizzle/0017), by table. */
const EXPECTED_CHECKS = [
  'forward_auth_access.forward_auth_access_user_or_group_check: CHECK (((("userId" IS NOT NULL) AND ("groupId" IS NULL)) OR (("userId" IS NULL) AND ("groupId" IS NOT NULL))))',
];

/** Triggers the migrations add (drizzle/0047), with when they fire. */
const EXPECTED_TRIGGERS: [name: string, firesOn: RegExp][] = [
  ['users.users_disabled_at_insert', /BEFORE INSERT ON (?:public\.)?users FOR EACH ROW WHEN .*EXECUTE FUNCTION (?:public\.)?users_disabled_at_stamp\(\)/],
  ['users.users_disabled_at_update', /BEFORE UPDATE OF status ON (?:public\.)?users FOR EACH ROW WHEN .*EXECUTE FUNCTION (?:public\.)?users_disabled_at_stamp\(\)/],
];

type ColumnRow = {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  is_identity: 'YES' | 'NO';
  identity_generation: string | null;
};
type ConstraintRow = { table: string; name: string; type: string; definition: string; columns: string[] };
type IndexRow = { table: string; name: string; unique: boolean; method: string; predicate: string | null; keys: string[] };

const pgTables = (Object.values(pgSchema) as unknown[]).filter((value): value is PgTable => is(value, PgTable));

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

/** An index key or expression, compared without quotes, spaces or case. */
function normalizeExpression(text: string): string {
  return text.replace(/["\s]/g, '').toLowerCase();
}

/** A column default as PostgreSQL reports it (information_schema.columns), as a JavaScript value. */
function parseDefault(value: string | null): unknown {
  if (value === null) return null;
  const text = value.trim();
  const quoted = /^'((?:[^']|'')*)'::(?:text|character varying)$/s.exec(text);
  if (quoted) return quoted[1].replace(/''/g, "'");
  const number = /^'?(-?\d+(?:\.\d+)?)'?(?:::(?:integer|bigint|numeric))?$/.exec(text);
  if (number) return Number(number[1]);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^null(::\w+)?$/i.test(text)) return null;
  return `expression ${text}`;
}

function schemaDefault(column: PgColumn): unknown {
  const value = column.default;
  if (value === undefined || value === null) return null;
  if (is(value, SQL)) return `expression ${renderSql(value)}`;
  return value;
}

/** Every difference between the database and schema.pg.ts, plus extra checks, triggers, foreign keys and objects. */
async function schemaDrift(client: Client): Promise<string[]> {
  const drift: string[] = [];
  const relations = (
    await client.query<{ name: string; kind: string }>(
      `SELECT relname AS name, relkind AS kind FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relkind NOT IN ('i', 'I', 'S', 't', 'c')
       ORDER BY relname`
    )
  ).rows;
  const columns = (
    await client.query<ColumnRow>(
      `SELECT table_name, column_name, data_type, is_nullable, column_default, is_identity, identity_generation
       FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`
    )
  ).rows;
  const constraints = (
    await client.query<ConstraintRow>(
      `SELECT cl.relname AS table, con.conname AS name, con.contype AS type, pg_get_constraintdef(con.oid) AS definition,
         array(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS columns
       FROM pg_constraint con JOIN pg_class cl ON cl.oid = con.conrelid
       WHERE con.connamespace = 'public'::regnamespace AND con.contype IN ('p', 'u', 'f', 'c', 'x')
       ORDER BY cl.relname, con.conname`
    )
  ).rows;
  // Indexes that back no constraint (the primary keys' are compared as constraints).
  const indexes = (
    await client.query<IndexRow>(
      `SELECT t.relname AS table, i.relname AS name, x.indisunique AS unique, am.amname AS method,
         pg_get_expr(x.indpred, x.indrelid) AS predicate,
         array(SELECT pg_get_indexdef(x.indexrelid, k, true) FROM generate_series(1, x.indnkeyatts) AS k) AS keys
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_class t ON t.oid = x.indrelid
       JOIN pg_am am ON am.oid = i.relam
       WHERE t.relnamespace = 'public'::regnamespace
         AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = x.indexrelid)
       ORDER BY t.relname, i.relname`
    )
  ).rows;

  const schemaTables = new Set(pgTables.map((table) => getTableConfig(table).name));
  for (const relation of relations) {
    if (relation.kind !== 'r') drift.push(`${relation.name}: relation of kind ${relation.kind} in the database only`);
    else if (!schemaTables.has(relation.name)) drift.push(`table ${relation.name}: in the database only`);
  }
  const databaseTables = new Set(relations.filter((relation) => relation.kind === 'r').map((relation) => relation.name));

  for (const table of pgTables) {
    const config = getTableConfig(table);
    const t = config.name;
    if (!databaseTables.has(t)) {
      drift.push(`table ${t}: missing from the database`);
      continue;
    }
    const byName = new Map(columns.filter((row) => row.table_name === t).map((row) => [row.column_name, row]));
    for (const column of config.columns) {
      const where = `${t}.${column.name}`;
      const row = byName.get(column.name);
      if (!row) {
        drift.push(`${where}: missing from the database`);
        continue;
      }
      if (row.data_type !== column.getSQLType()) drift.push(`${where}: type ${row.data_type} in the database, ${column.getSQLType()} in the schema`);
      const notNull = row.is_nullable === 'NO';
      if (notNull !== column.notNull) drift.push(`${where}: NOT NULL ${notNull} in the database, ${column.notNull} in the schema`);
      const identity = (column as unknown as { generatedIdentity?: { type: 'always' | 'byDefault' } }).generatedIdentity?.type;
      const databaseIdentity = row.is_identity === 'YES' ? (row.identity_generation === 'ALWAYS' ? 'always' : 'byDefault') : undefined;
      if (databaseIdentity !== identity) drift.push(`${where}: identity ${databaseIdentity ?? 'none'} in the database, ${identity ?? 'none'} in the schema`);
      const databaseDefault = parseDefault(row.column_default);
      const expectedDefault = schemaDefault(column);
      if (databaseDefault !== expectedDefault) {
        drift.push(`${where}: default ${JSON.stringify(databaseDefault)} in the database, ${JSON.stringify(expectedDefault)} in the schema`);
      }
    }
    for (const row of byName.values()) {
      if (!config.columns.some((column) => column.name === row.column_name)) drift.push(`${t}.${row.column_name}: in the database only`);
    }

    const own = constraints.filter((row) => row.table === t);
    const primary = config.primaryKeys.length > 0
      ? config.primaryKeys.map((key) => key.columns.map((column) => column.name))
      : config.columns.filter((column) => column.primary).map((column) => [column.name]);
    const databasePrimary = own.filter((row) => row.type === 'p').map((row) => row.columns);
    if (JSON.stringify(databasePrimary) !== JSON.stringify(primary)) {
      drift.push(`table ${t}: primary key ${JSON.stringify(databasePrimary)} in the database, ${JSON.stringify(primary)} in the schema`);
    }
    const unique = [
      ...config.uniqueConstraints.map((constraint) => constraint.columns.map((column) => column.name).join(', ')),
      ...config.columns.filter((column) => column.isUnique).map((column) => column.name),
    ].sort();
    const databaseUnique = own.filter((row) => row.type === 'u').map((row) => row.columns.join(', ')).sort();
    if (JSON.stringify(databaseUnique) !== JSON.stringify(unique)) {
      drift.push(`table ${t}: unique constraints (${databaseUnique.join('; ')}) in the database, (${unique.join('; ')}) in the schema`);
    }
    for (const row of own.filter((candidate) => candidate.type === 'f' || candidate.type === 'x')) {
      drift.push(`${row.type === 'f' ? 'foreign key' : 'exclusion constraint'} ${row.name} on ${t}: in the database only`);
    }

    const ownIndexes = indexes.filter((row) => row.table === t);
    for (const index of config.indexes) {
      const { name, unique: isUnique, columns: keys, where } = index.config;
      const row = ownIndexes.find((candidate) => candidate.name === name);
      if (!row) {
        drift.push(`index ${name} on ${t}: missing from the database`);
        continue;
      }
      if (row.unique !== isUnique) drift.push(`index ${name} on ${t}: unique ${row.unique} in the database, ${isUnique} in the schema`);
      if (row.method !== 'btree') drift.push(`index ${name} on ${t}: ${row.method} in the database, btree in the schema`);
      const databasePredicate = row.predicate ? normalizeExpression(row.predicate) : null;
      const schemaPredicate = where ? normalizeExpression(renderSql(where)) : null;
      if (databasePredicate !== schemaPredicate) drift.push(`index ${name} on ${t}: WHERE ${databasePredicate} in the database, ${schemaPredicate} in the schema`);
      const databaseKeys = row.keys.map(normalizeExpression);
      const schemaKeys = keys.map((key) => normalizeExpression(is(key, SQL) ? renderSql(key) : (key as PgColumn).name));
      if (databaseKeys.join(',') !== schemaKeys.join(',')) {
        drift.push(`index ${name} on ${t}: (${databaseKeys.join(', ')}) in the database, (${schemaKeys.join(', ')}) in the schema`);
      }
    }
    for (const row of ownIndexes) {
      if (!config.indexes.some((index) => index.config.name === row.name)) {
        drift.push(`${row.unique ? 'unique index' : 'index'} ${row.name} on ${t} (${row.keys.join(', ')}): in the database only`);
      }
    }
  }
  return drift;
}

async function checks(client: Client): Promise<string[]> {
  const rows = (
    await client.query<{ table: string; name: string; definition: string }>(
      `SELECT cl.relname AS table, con.conname AS name, pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con JOIN pg_class cl ON cl.oid = con.conrelid
       WHERE con.connamespace = 'public'::regnamespace AND con.contype = 'c'
       ORDER BY cl.relname, con.conname`
    )
  ).rows;
  return rows.map((row) => `${row.table}.${row.name}: ${row.definition}`);
}

async function triggers(client: Client): Promise<{ name: string; definition: string }[]> {
  return (
    await client.query<{ name: string; definition: string }>(
      `SELECT c.relname || '.' || t.tgname AS name, pg_get_triggerdef(t.oid) AS definition
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
       ORDER BY 1`
    )
  ).rows;
}

describe.skipIf(!TEST_DATABASE_URL)('PostgreSQL migrations match schema.pg.ts', () => {
  let database: PgTestDatabase;

  beforeAll(async () => {
    database = await createPgTestDatabase('schema');
    await migratePgDatabase(database.client);
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('runs on PostgreSQL 16 or later, in a database with C collation and character classification', async () => {
    const { rows } = await database.client.query<{ version: number; collate: string; ctype: string; encoding: string }>(
      `SELECT current_setting('server_version_num')::int AS version, datcollate AS collate, datctype AS ctype,
         pg_encoding_to_char(encoding) AS encoding
       FROM pg_database WHERE datname = current_database()`
    );
    expect(rows[0].version).toBeGreaterThanOrEqual(160000);
    expect(rows[0]).toMatchObject({ collate: 'C', ctype: 'C', encoding: 'UTF8' });
  });

  it('checks every table of the schema', () => {
    expect(pgTables.length).toBeGreaterThan(80);
  });

  it('builds the tables, columns, keys and indexes the schema declares, and nothing else', async () => {
    expect(await schemaDrift(database.client)).toEqual([]);
  });

  it('adds the CHECK, the triggers and their functions of the SQLite migrations', async () => {
    expect(await checks(database.client)).toEqual(EXPECTED_CHECKS);
    const found = await triggers(database.client);
    expect(found.map((trigger) => trigger.name)).toEqual(EXPECTED_TRIGGERS.map(([name]) => name));
    for (const [name, firesOn] of EXPECTED_TRIGGERS) {
      expect(found.find((trigger) => trigger.name === name)?.definition, name).toMatch(firesOn);
    }
    const functions = await database.client.query<{ name: string; language: string }>(
      `SELECT p.proname AS name, l.lanname AS language FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
       WHERE p.pronamespace = 'public'::regnamespace ORDER BY 1`
    );
    expect(functions.rows).toEqual([
      { name: 'users_disabled_at_stamp', language: 'plpgsql' },
    ]);
  });

  it('has a sequence for each identity column and no other', async () => {
    const { rows } = await database.client.query<{ name: string; identity: boolean }>(
      `SELECT s.relname AS name,
         EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = s.oid AND d.deptype = 'i') AS identity
       FROM pg_class s WHERE s.relnamespace = 'public'::regnamespace AND s.relkind = 'S' ORDER BY 1`
    );
    const identityColumns = pgTables.flatMap((table) =>
      getTableConfig(table).columns.filter((column) => (column as unknown as { generatedIdentity?: unknown }).generatedIdentity)
    );
    expect(rows.filter((row) => !row.identity)).toEqual([]);
    expect(rows).toHaveLength(identityColumns.length);
  });

  it('records the baseline under the time of the SQLite migration it equals, and applies it once', async () => {
    const journal = JSON.parse(readFileSync(resolve(PG_MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
      entries: { when: number }[];
    };
    const applied = async () =>
      (await database.client.query<{ created_at: string }>('SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows;
    expect(await applied()).toEqual(journal.entries.map((entry) => ({ created_at: String(entry.when) })));
    await migratePgDatabase(database.client);
    expect(await applied()).toHaveLength(journal.entries.length);
  });

  it('notices a column, default, index, key or table the schema does not have', async () => {
    const altered = await createPgTestDatabase('schema_altered');
    try {
      await migratePgDatabase(altered.client);
      await altered.client.query(`
        ALTER TABLE "settings" ADD COLUMN "extra" text;
        ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'viewer';
        DROP INDEX "users_email_unique";
        CREATE TABLE "stray" ("id" integer PRIMARY KEY);
        CREATE UNIQUE INDEX "sessions_extra_unique" ON "sessions" ("userAgent", "ipAddress");
        ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_fk" FOREIGN KEY ("userId") REFERENCES "users" ("id");
      `);
      expect(await schemaDrift(altered.client)).toEqual([
        'table stray: in the database only',
        'users.role: default "viewer" in the database, "user" in the schema',
        'index users_email_unique on users: missing from the database',
        'foreign key sessions_user_fk on sessions: in the database only',
        'unique index sessions_extra_unique on sessions ("userAgent", "ipAddress"): in the database only',
        'settings.extra: in the database only',
      ]);
    } finally {
      await altered.drop();
    }
  });
});
