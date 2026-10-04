/**
 * The SQLite → PostgreSQL copy (src/lib/db/copy/): the table list it builds
 * from the schema covers every table the SQLite migrations create, values
 * convert exactly or are refused, both sides of the checksum agree, and the
 * copy (like the break-glass tool) never loads the application's database
 * modules (they would open, migrate and repair the SQLite file DATABASE_URL
 * names).
 * The copy itself runs against PostgreSQL in
 * tests/integration/pg/copy-sqlite-to-postgres.test.ts.
 */
import Database from 'better-sqlite3';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';
import { isInternalSqliteTable } from '../../src/lib/db/copy/source';
import {
  copyTables,
  postgresToken,
  sqliteToken,
  TableDigest,
  toPostgresValue,
  UnsupportedValueError,
  type ColumnKind,
} from '../../src/lib/db/copy/tables';
import { formatVerifyReport } from '../../src/lib/db/copy/verify';
import { PG_INTEGER_COLUMNS } from '../../src/lib/db/pg-column-types';

function migratedTableNames(): string[] {
  const client = new Database(':memory:');
  try {
    migrate(drizzle(client), { migrationsFolder: resolve(process.cwd(), 'drizzle') });
    return (client.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name)
      .filter((name) => !isInternalSqliteTable(name))
      .sort();
  } finally {
    client.close();
  }
}

describe('the tables the copy moves', () => {
  it('are every table the SQLite migrations create', () => {
    expect(copyTables().map((table) => table.name).sort()).toEqual(migratedTableNames());
  });

  it("include Better Auth's tables", () => {
    const names = copyTables().map((table) => table.name);
    for (const name of ['users', 'accounts', 'sessions', 'verifications', 'two_factors', 'passkeys']) {
      expect(names).toContain(name);
    }
  });

  it('give every integer column the width pg-column-types.ts gives it', () => {
    for (const table of copyTables()) {
      for (const column of table.columns) {
        if (column.kind !== 'int4' && column.kind !== 'int8') continue;
        expect(`${table.name}.${column.name}: ${PG_INTEGER_COLUMNS[table.name]?.[column.name]}`).toBe(
          `${table.name}.${column.name}: ${column.kind}`
        );
      }
    }
  });

  it('know the identity column of every AUTOINCREMENT table', () => {
    const users = copyTables().find((table) => table.name === 'users')!;
    expect(users.identity).toBe('id');
    expect(users.primaryKey).toEqual(['id']);
    const settings = copyTables().find((table) => table.name === 'settings')!;
    expect(settings.identity).toBeNull();
    expect(settings.primaryKey).toEqual(['key']);
    expect(copyTables().every((table) => table.primaryKey.length > 0)).toBe(true);
  });
});

describe('values written to PostgreSQL', () => {
  it('keep integers exact, booleans as booleans and text as it is', () => {
    expect(toPostgresValue('int4', 2_147_483_647n)).toBe(2_147_483_647);
    expect(toPostgresValue('int4', -2_147_483_648n)).toBe(-2_147_483_648);
    expect(toPostgresValue('int8', 9_223_372_036_854_775_807n)).toBe('9223372036854775807');
    expect(toPostgresValue('int8', -9_223_372_036_854_775_808n)).toBe('-9223372036854775808');
    expect(toPostgresValue('boolean', 1n)).toBe(true);
    expect(toPostgresValue('boolean', 0n)).toBe(false);
    expect(toPostgresValue('text', '{"a":"ü 🚀"}')).toBe('{"a":"ü 🚀"}');
    expect(toPostgresValue('text', '')).toBe('');
    for (const kind of ['int4', 'int8', 'boolean', 'text'] as ColumnKind[]) {
      expect(toPostgresValue(kind, null)).toBeNull();
    }
  });

  it('refuse what PostgreSQL cannot hold, without repeating the value', () => {
    const refused = (kind: ColumnKind, value: unknown) => {
      try {
        toPostgresValue(kind, value as never);
      } catch (error) {
        expect(error).toBeInstanceOf(UnsupportedValueError);
        return (error as UnsupportedValueError).problem;
      }
      throw new Error('not refused');
    };
    expect(refused('int4', 2_147_483_648n)).toMatch(/outside the range of a PostgreSQL integer/);
    expect(refused('int4', 'twelve')).toBe('holds text where an integer belongs');
    expect(refused('int8', 1.5)).toBe('holds a decimal number where an integer belongs');
    expect(refused('boolean', 2n)).toBe('holds 2 where a boolean (0 or 1) belongs');
    expect(refused('text', 'secret\u0000value')).toBe('holds text with a NUL character, which PostgreSQL cannot store');
    expect(refused('text', 'secret\u0000value')).not.toContain('secret');
    expect(refused('text', new Uint8Array([1, 2]))).toBe('holds binary data where text belongs');
    expect(refused('text', 5n)).toBe('holds bigint where text belongs');
  });
});

describe('the checksums', () => {
  it('normalise both sides to the same tokens', () => {
    // SQLite value (safeIntegers) → PostgreSQL value cast to text.
    const pairs: Array<[ColumnKind, unknown, string | null]> = [
      ['int4', 2_147_483_647n, '2147483647'],
      ['int8', -9_223_372_036_854_775_808n, '-9223372036854775808'],
      ['boolean', 1n, 'true'],
      ['boolean', 0n, 'false'],
      ['text', 'Zürich 🚀', 'Zürich 🚀'],
      ['text', null, null],
    ];
    for (const [kind, sqlite, pg] of pairs) expect(sqliteToken(kind, sqlite as never)).toBe(postgresToken(pg));
  });

  it('never equal a PostgreSQL value for what PostgreSQL cannot hold', () => {
    expect(sqliteToken('boolean', 2n)).not.toMatch(/^(true|false)$/);
    expect(sqliteToken('text', 5n)).not.toBe('5');
    expect(sqliteToken('int4', 'x')).not.toBe('x');
    expect(sqliteToken('int4', 1.5)).not.toBe('1.5');
  });

  it('do not depend on the order of the rows, and tell rows and values apart', () => {
    const rows = [['1', 'a'], ['2', null], ['3', 'c']];
    const forward = new TableDigest();
    const backward = new TableDigest();
    for (const row of rows) forward.add(row);
    for (const row of [...rows].reverse()) backward.add(row);
    expect(forward.checksum).toBe(backward.checksum);
    expect(forward.rows).toBe(3);

    const changed = new TableDigest();
    for (const row of [['1', 'a'], ['2', ''], ['3', 'c']]) changed.add(row);
    expect(changed.checksum).not.toBe(forward.checksum);
    const shifted = new TableDigest();
    for (const row of [['1', 'a'], ['2', null], ['3c', '']]) shifted.add(row);
    expect(shifted.checksum).not.toBe(forward.checksum);
  });
});

describe('the verification report', () => {
  it('lists every table, with both checksums where they differ', () => {
    const same = 'a'.repeat(64);
    const lines = formatVerifyReport({
      ok: false,
      tables: [
        { table: 'audit_events', sourceRows: 100, targetRows: 100, sourceChecksum: same, targetChecksum: same, matches: true },
        { table: 'settings', sourceRows: 3, targetRows: 0, sourceChecksum: 'b'.repeat(64), targetChecksum: '0'.repeat(64), matches: false },
        { table: 'users', sourceRows: 4, targetRows: 4, sourceChecksum: 'c'.repeat(64), targetChecksum: 'd'.repeat(64), matches: false },
      ],
    });
    expect(lines).toEqual([
      `  audit_events  same       100 rows, checksum ${'a'.repeat(16)}`,
      `  settings      DIFFERENT  3 rows in SQLite, 0 in PostgreSQL, checksums ${'b'.repeat(16)} and ${'0'.repeat(16)}`,
      `  users         DIFFERENT  4 rows each, checksums ${'c'.repeat(16)} and ${'d'.repeat(16)}`,
      '2 of 3 tables differ.',
    ]);
  });
});

/** The project files `file` imports (relative and @/ specifiers), resolved to paths. */
function localImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const specifiers = [
    ...text.matchAll(/\b(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']/g),
    ...text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
    ...text.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
  ].map((match) => match[1]);
  const root = process.cwd();
  const files: string[] = [];
  for (const specifier of specifiers) {
    let base: string;
    if (specifier.startsWith('.')) base = resolve(dirname(file), specifier);
    else if (specifier.startsWith('@/')) base = resolve(root, specifier.slice(2));
    else continue;
    const found = [`${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts'), base].find((candidate) => existsSync(candidate) && candidate.endsWith('.ts'));
    if (found) files.push(found);
  }
  return files;
}

describe('the copy modules and the break-glass tool', () => {
  it("never load the application's database modules, directly or through other modules", () => {
    const root = process.cwd();
    const forbidden = new Set(
      ['src/lib/db.ts', ...['executor', 'sqlite', 'ops', 'schema', 'startup', 'locks', 'auth-database', 'cached-value', 'events'].map((name) => `src/lib/db/${name}.ts`)]
        .map((path) => resolve(root, path))
    );
    const folder = resolve(root, 'src/lib/db/copy');
    const queue = [
      ...readdirSync(folder).map((name) => resolve(folder, name)),
      resolve(root, 'scripts/db/copy-sqlite-to-postgres.ts'),
      resolve(root, 'scripts/db/break-glass.ts'),
    ];
    const seen = new Set<string>();
    const reached: string[] = [];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      if (forbidden.has(file)) reached.push(relative(root, file));
      queue.push(...localImports(file));
    }
    expect(reached).toEqual([]);
    // The walk does reach the modules the copy does use.
    expect(seen.has(resolve(root, 'src/lib/db/pg-startup.ts'))).toBe(true);
    expect(seen.has(resolve(root, 'src/lib/db/schema.pg.ts'))).toBe(true);
    expect(seen.has(resolve(root, 'src/lib/db/break-glass.ts'))).toBe(true);
  });
});
