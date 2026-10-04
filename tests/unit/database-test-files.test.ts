/**
 * The test files the postgres Vitest project runs (tests/vitest.config.ts,
 * tests/helpers/database-test-files.ts): every test file that imports the
 * database layer, directly or through what it imports, except the
 * SQLite-only files listed with a reason. A new database test therefore
 * runs on PostgreSQL without being listed anywhere.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  filesImportingDatabase,
  listTestFiles,
  postgresTestFiles,
  readSqliteOnlyList,
} from '../helpers/database-test-files';

const ROOT = process.cwd();

describe('the database tests of a repository', () => {
  let root: string;
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const selected = (sqliteOnly: Record<string, string> = {}) =>
    postgresTestFiles(listTestFiles([join(root, 'tests')]), root, { files: sqliteOnly }).map((file) => file.slice(root.length + 1));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'db-tests-'));
    write('src/lib/db.ts', 'export const appDb = {};\n');
    write('src/lib/db/ops.ts', 'export const first = () => null;\n');
    write('src/lib/models.ts', "import { appDb } from './db';\nexport const read = () => appDb;\n");
    write('src/lib/service.ts', "import { read } from '@/src/lib/models';\nexport const run = read;\n");
    write('src/lib/types-only.ts', "import type { appDb } from './db';\nexport type Db = typeof appDb;\n");
    write('src/lib/types-block.ts', "import type {\n  appDb,\n} from './db';\nexport const pure = 1;\n");
    write('src/lib/pure.ts', 'export const add = (a: number, b: number) => a + b;\n');
    write('src/lib/cycle-a.ts', "import { b } from './cycle-b';\nexport const a = () => b;\n");
    write('src/lib/cycle-b.ts', "import { a } from './cycle-a';\nimport { first } from './db/ops';\nexport const b = () => [a, first];\n");
    write('src/lib/lazy.ts', "export async function load() {\n  return (await import('./models')).read;\n}\n");
    write('src/lib/dir/index.ts', "export * from '../models';\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('take every test that reaches the database layer, however indirectly', () => {
    write('tests/unit/direct.test.ts', "import { appDb } from '../../src/lib/db';\n");
    write('tests/unit/through-alias.test.ts', "import { run } from '@/src/lib/service';\n");
    write('tests/unit/through-src-alias.test.ts', "import { run } from '@/lib/service';\n");
    write('tests/unit/through-cycle.test.ts', "import { a } from '@/src/lib/cycle-a';\n");
    write('tests/unit/dynamic.test.ts', "it('loads', async () => { await import('../../src/lib/lazy'); });\n");
    write('tests/unit/index.test.ts', "import { read } from '../../src/lib/dir';\n");
    write('tests/unit/mocked.test.ts', "vi.mock('@/src/lib/db', () => ({ appDb: {} }));\n");
    write('tests/integration/nested/deep.test.ts', "import { first } from '@/src/lib/db/ops';\n");
    expect(selected()).toEqual([
      'tests/integration/nested/deep.test.ts',
      'tests/unit/direct.test.ts',
      'tests/unit/dynamic.test.ts',
      'tests/unit/index.test.ts',
      'tests/unit/mocked.test.ts',
      'tests/unit/through-alias.test.ts',
      'tests/unit/through-cycle.test.ts',
      'tests/unit/through-src-alias.test.ts',
    ]);
  });

  it('leave out tests that never load it: pure modules, type-only imports, packages', () => {
    write('tests/unit/pure.test.ts', "import { add } from '@/src/lib/pure';\nimport { describe } from 'vitest';\n");
    write('tests/unit/types.test.ts', "import type { Db } from '@/src/lib/types-only';\nimport { pure } from '@/src/lib/types-block';\n");
    write('tests/unit/missing.test.ts', "import { gone } from '@/src/lib/missing';\n");
    expect(selected()).toEqual([]);
  });

  it('leave out the SQLite-only files', () => {
    write('tests/unit/direct.test.ts', "import { appDb } from '../../src/lib/db';\n");
    write('tests/unit/sqlite.test.ts', "import { appDb } from '../../src/lib/db';\n");
    expect(selected({ 'tests/unit/sqlite.test.ts': 'Tests SQLite itself.' })).toEqual(['tests/unit/direct.test.ts']);
  });

  it('answer for a set of files at once, sharing the walk', () => {
    write('tests/unit/a.test.ts', "import { run } from '@/src/lib/service';\n");
    write('tests/unit/b.test.ts', "import { add } from '@/src/lib/pure';\n");
    const files = listTestFiles([join(root, 'tests')]);
    expect([...filesImportingDatabase(files, root)]).toEqual([join(root, 'tests/unit/a.test.ts')]);
  });
});

describe('this repository', () => {
  const sqliteOnly = readSqliteOnlyList(resolve(ROOT, 'tests/sqlite-only.json'));
  const all = listTestFiles([resolve(ROOT, 'tests/unit'), resolve(ROOT, 'tests/integration')]);
  const postgres = new Set(postgresTestFiles(all, ROOT, sqliteOnly).map((file) => file.slice(ROOT.length + 1)));

  it('lists only existing SQLite-only files, each with its reason', () => {
    for (const [file, reason] of Object.entries(sqliteOnly.files)) {
      expect(existsSync(resolve(ROOT, file)), file).toBe(true);
      expect(reason.trim().length, file).toBeGreaterThan(20);
      expect(postgres.has(file), file).toBe(false);
    }
  });

  it('runs the database tests on PostgreSQL and leaves out the rest', () => {
    for (const file of ['tests/integration/cluster-nodes.test.ts', 'tests/integration/pg/executor.test.ts', 'tests/unit/ha-background-jobs.test.ts']) {
      expect(postgres.has(file), file).toBe(true);
    }
    for (const file of ['tests/unit/row-ids.test.ts', 'tests/unit/permission-call-sites.test.ts']) {
      expect(postgres.has(file), file).toBe(false);
    }
    expect(postgres.size).toBeGreaterThan(250);
  });
});
