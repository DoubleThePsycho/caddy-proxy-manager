/**
 * Which test files the postgres Vitest project runs (tests/vitest.config.ts):
 * every test file that imports the database layer (src/lib/db.ts or
 * src/lib/db/**), directly or through what it imports, except the SQLite-only
 * files listed with their reason in tests/sqlite-only.json. So a new test of
 * anything that touches the database runs on PostgreSQL as well without being
 * listed anywhere. A file that never reaches the database layer cannot behave
 * differently on PostgreSQL (the dialect is only known there), so running it
 * again would only cost time.
 *
 * The imports are read from the source text: static and dynamic imports,
 * re-exports, require(), and the paths given to vi.mock, vi.doMock and
 * vi.importActual (a test that mocks the database is still about code that
 * uses it). They are resolved as the project resolves them: relative paths,
 * "@/" from the repository root (then from src/, as tsconfig.json's paths),
 * with .ts, .tsx or an index file. Type-only imports load nothing and are
 * skipped; packages are not followed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bvi\.(?:mock|doMock|importActual)\s*(?:<[^>]*>)?\s*\(\s*)(['"])([^'"\n]+)\1/g;
/** `import type …;` and `export type … from …;`, over several lines. */
const TYPE_ONLY = /^\s*(?:import|export)\s+type\s[^;]*;/gm;

export type SqliteOnlyList = {
  $comment?: string;
  /** Test file (from the repository root) → why it does not run on PostgreSQL. */
  files: Record<string, string>;
};

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The modules a file loads, as files of the repository. */
function localImports(file: string, root: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const found = new Set<string>();
  for (const match of text.replace(TYPE_ONLY, '').matchAll(SPECIFIER)) {
    const target = resolveSpecifier(file, match[2], root);
    if (target) found.add(target);
  }
  return [...found];
}

function resolveSpecifier(from: string, specifier: string, root: string): string | null {
  let bases: string[];
  if (specifier.startsWith('@/')) bases = [join(root, specifier.slice(2)), join(root, 'src', specifier.slice(2))];
  else if (specifier.startsWith('./') || specifier.startsWith('../')) bases = [resolve(dirname(from), specifier)];
  else return null;
  for (const base of bases) {
    const stem = base.replace(/\.js$/, '');
    for (const candidate of [base, `${stem}.ts`, `${stem}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
      if (/\.tsx?$/.test(candidate) && isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Whether `file` (absolute) is part of the database layer. */
export function isDatabaseLayer(file: string, root: string): boolean {
  const path = relative(root, file).split('\\').join('/');
  return path === 'src/lib/db.ts' || path.startsWith('src/lib/db/');
}

/** The files among `files` (absolute) that import the database layer, directly or not. */
export function filesImportingDatabase(files: readonly string[], root: string): Set<string> {
  // The import graph from the test files, not entered past the database layer.
  const importers = new Map<string, string[]>();
  const seen = new Set<string>(files);
  const queue = [...files];
  const database: string[] = [];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (isDatabaseLayer(file, root)) {
      database.push(file);
      continue;
    }
    for (const target of localImports(file, root)) {
      const list = importers.get(target);
      if (list) list.push(file);
      else importers.set(target, [file]);
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  // Everything from which the database layer can be reached.
  const reaching = new Set<string>(database);
  const back = [...database];
  while (back.length > 0) {
    for (const importer of importers.get(back.pop()!) ?? []) {
      if (reaching.has(importer)) continue;
      reaching.add(importer);
      back.push(importer);
    }
  }
  return new Set(files.filter((file) => reaching.has(file)));
}

/** Every `*.test.ts` file under `dirs` (absolute), sorted. */
export function listTestFiles(dirs: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.test.ts')) out.push(path);
    }
  };
  for (const dir of dirs) walk(dir);
  return out.sort();
}

export function readSqliteOnlyList(path: string): SqliteOnlyList {
  return JSON.parse(readFileSync(path, 'utf8')) as SqliteOnlyList;
}

/**
 * The test files of the postgres project: those of `files` (absolute) that
 * import the database layer and are not SQLite-only.
 */
export function postgresTestFiles(files: readonly string[], root: string, sqliteOnly: SqliteOnlyList): string[] {
  const skipped = new Set(Object.keys(sqliteOnly.files).map((file) => resolve(root, file)));
  const database = filesImportingDatabase(files, root);
  return files.filter((file) => database.has(file) && !skipped.has(file));
}
