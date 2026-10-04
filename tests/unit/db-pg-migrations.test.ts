/**
 * The PostgreSQL migrations (drizzle-pg/) without a server:
 * - drizzle-kit's newest snapshot there is schema.pg.ts, so the migrations
 *   cover the schema and `drizzle-kit generate --config drizzle.pg.config.ts`
 *   emits only what a new change adds (drizzle-pg/README.md);
 * - the baseline holds drizzle-kit's statements for its snapshot unchanged;
 * - no foreign keys (SQLite does not enforce its own);
 * - nothing newer than PostgreSQL 16, the oldest version supported.
 * tests/integration/pg/ applies them to a real server.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateDrizzleJson, generateMigration, type DrizzleSnapshotJSON } from 'drizzle-kit/api';
import * as pgSchema from '../../src/lib/db/schema.pg';

const FOLDER = resolve(process.cwd(), 'drizzle-pg');
const ORIGIN = '00000000-0000-0000-0000-000000000000';

type JournalEntry = { idx: number; when: number; tag: string };

const journal = JSON.parse(readFileSync(resolve(FOLDER, 'meta/_journal.json'), 'utf8')) as { entries: JournalEntry[] };
const snapshotFiles = readdirSync(resolve(FOLDER, 'meta')).filter((name) => name.endsWith('_snapshot.json')).sort();
const snapshot = (file: string) => JSON.parse(readFileSync(resolve(FOLDER, 'meta', file), 'utf8')) as DrizzleSnapshotJSON;
const migrations = journal.entries.map((entry) => ({ tag: entry.tag, sql: readFileSync(resolve(FOLDER, `${entry.tag}.sql`), 'utf8') }));

/** A migration's statements without comments, as Drizzle's migrator splits them. */
function statements(sql: string): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map((chunk) => chunk.split('\n').filter((line) => !/^\s*--/.test(line)).join('\n').trim())
    .filter(Boolean);
}

/**
 * The SQL that matters for version checks: comments dropped, string literals
 * and quoted identifiers blanked (a column named "json_value" or a default
 * mentioning VIRTUAL is no feature). Dollar-quoted function bodies are code
 * and stay.
 */
function codeOnly(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    if (char === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
    } else if (char === "'" || char === '"') {
      let end = i + 1;
      while (end < sql.length && !(sql[end] === char && sql[end + 1] !== char)) end += sql[end] === char ? 2 : 1;
      out += `${char}${char}`;
      i = end + 1;
    } else {
      out += char;
      i++;
    }
  }
  return out;
}

/** Syntax and functions newer than PostgreSQL 16 (D1: PostgreSQL 16 or later, tested on 17). */
const NEWER_THAN_16: [RegExp, string][] = [
  [/\bjson_(table|exists|query|value|scalar|serialize)\s*\(/i, 'SQL/JSON query functions (17)'],
  [/\bjson\s*\(/i, 'the JSON() constructor (17)'],
  [/\bmerge_action\s*\(|\bnot\s+matched\s+by\s+source\b/i, 'MERGE additions (17)'],
  [/\bmerge\s+into\b[^;]*\breturning\b/i, 'MERGE ... RETURNING (17)'],
  [/\bset\s+expression\b/i, 'ALTER COLUMN ... SET EXPRESSION (17)'],
  [/\bat\s+local\b/i, 'AT LOCAL (17)'],
  [/\bset\s+access\s+method\s+default\b/i, 'SET ACCESS METHOD DEFAULT (17)'],
  [/\b(on_error|log_verbosity|reject_limit)\b/i, 'COPY options (17, 18)'],
  [/\b(uuid_extract_timestamp|uuid_extract_version|unicode_assigned|to_regtypemod|pg_basetype|xmltext|to_bin|to_oct)\s*\(/i, 'functions added in 17'],
  [/\b(uuidv4|uuidv7|casefold|array_sort|array_reverse|crc32c?|gamma|lgamma|pg_get_acl)\s*\(/i, 'functions added in 18'],
  [/\bvirtual\b/i, 'virtual generated columns (18)'],
  [/\bnot\s+enforced\b/i, 'NOT ENFORCED constraints (18)'],
  [/\bwithout\s+overlaps\b/i, 'temporal keys (18)'],
  [/\bnot\s+null\b[^,;]*\bnot\s+valid\b/i, 'NOT NULL ... NOT VALID (18)'],
  [/\breturning\b[^;]*\b(old|new)\s*\./i, 'RETURNING OLD/NEW (18)'],
];

function newerThan16(sql: string): string[] {
  const code = codeOnly(sql);
  return NEWER_THAN_16.filter(([pattern]) => pattern.test(code)).map(([, feature]) => feature);
}

describe('PostgreSQL migrations', () => {
  it('keep a drizzle-kit snapshot for every migration, chained in journal order', () => {
    expect(snapshotFiles).toEqual(journal.entries.map((entry) => `${entry.tag.slice(0, 4)}_snapshot.json`).sort());
    let previous = ORIGIN;
    for (const entry of journal.entries) {
      const current = snapshot(`${entry.tag.slice(0, 4)}_snapshot.json`);
      expect(current.prevId, entry.tag).toBe(previous);
      previous = current.id;
    }
  });

  it('cover schema.pg.ts: the newest snapshot is the schema', async () => {
    const newest = snapshot(`${journal.entries.at(-1)!.tag.slice(0, 4)}_snapshot.json`);
    expect(await generateMigration(newest, generateDrizzleJson(pgSchema))).toEqual([]);
  });

  it('hold in the baseline the statements drizzle-kit generates for its snapshot, unchanged', async () => {
    const generated = await generateMigration(generateDrizzleJson({}), snapshot('0000_snapshot.json'));
    const baseline = statements(migrations[0].sql);
    expect(generated.length).toBeGreaterThan(150);
    for (const statement of generated) expect(baseline, statement).toContain(statement.trim());
    // What follows them is what the Drizzle schema does not express.
    expect(baseline.slice(generated.length).map((statement) => /^CREATE (FUNCTION|TRIGGER) "?(\w+)|^ALTER TABLE "(\w+)" ADD CONSTRAINT "(\w+)"/.exec(statement)?.slice(2).filter(Boolean).join(' '))).toEqual([
      'forward_auth_access forward_auth_access_user_or_group_check',
      'users_organization_role_guard',
      'users_organization_role_insert',
      'users_organization_role_update',
      'users_disabled_at_stamp',
      'users_disabled_at_insert',
      'users_disabled_at_update',
    ]);
  });

  it('declare no foreign keys', () => {
    for (const { tag, sql } of migrations) expect(codeOnly(sql), tag).not.toMatch(/\b(references|foreign\s+key)\b/i);
  });

  it('use nothing newer than PostgreSQL 16', () => {
    for (const { tag, sql } of migrations) expect(newerThan16(sql), tag).toEqual([]);
  });

  it('would notice syntax newer than PostgreSQL 16, outside comments, strings and identifiers', () => {
    expect(newerThan16(`ALTER TABLE "t" ADD COLUMN "c" integer GENERATED ALWAYS AS ("a" + 1) VIRTUAL;`)).toEqual(['virtual generated columns (18)']);
    expect(newerThan16(`SELECT json_value("doc", '$.a') FROM "t";`)).toEqual(['SQL/JSON query functions (17)']);
    expect(newerThan16(`UPDATE "t" SET "a" = 1 RETURNING old."a";`)).toEqual(['RETURNING OLD/NEW (18)']);
    expect(newerThan16(`-- uuidv7() would be nice\nCREATE TABLE "virtual" ("json_value" text DEFAULT 'at local');`)).toEqual([]);
  });
});
