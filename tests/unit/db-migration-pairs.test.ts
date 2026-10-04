/**
 * The SQLite migrations (drizzle/) and the PostgreSQL migrations (drizzle-pg/)
 * stay in step. The PostgreSQL baseline builds the database the SQLite
 * migrations build up to the one named in drizzle-pg/meta/_sqlite-equivalence.json;
 * every later migration exists in both folders under the same tag, at the same
 * place in both journals and with the same `when` (Drizzle's migrators apply a
 * migration whose `when` is later than the last one applied, so it must grow).
 * See drizzle-pg/README.md.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };
type Equivalence = { baseline: string; sqlite: string };
type Folder = { journal: Journal; sqlFiles: string[] };

const ROOT = process.cwd();

function readFolder(folder: string): Folder {
  return {
    journal: JSON.parse(readFileSync(resolve(ROOT, folder, 'meta/_journal.json'), 'utf8')) as Journal,
    sqlFiles: readdirSync(resolve(ROOT, folder)).filter((name) => name.endsWith('.sql')).sort(),
  };
}

function strictlyGrowing(entries: JournalEntry[], folder: string): string[] {
  return entries.slice(1).flatMap((entry, i) =>
    entry.when > entries[i].when ? [] : [`${folder}${entry.tag}: when ${entry.when} is not after ${entries[i].tag} (${entries[i].when})`]
  );
}

function filesMatchJournal({ journal, sqlFiles }: Folder, folder: string): string[] {
  const tags = journal.entries.map((entry) => entry.tag);
  return [
    ...tags.filter((tag) => !sqlFiles.includes(`${tag}.sql`)).map((tag) => `${folder}${tag}.sql: missing`),
    ...sqlFiles.filter((file) => !tags.includes(file.replace(/\.sql$/, ''))).map((file) => `${folder}${file}: not in the journal`),
  ];
}

/** Everything that keeps the two folders from being in step; empty when they are. */
function migrationPairProblems(sqlite: Folder, postgres: Folder, equivalence: Equivalence): string[] {
  const problems: string[] = [];
  if (sqlite.journal.dialect !== 'sqlite') problems.push(`drizzle/: dialect ${sqlite.journal.dialect}`);
  if (postgres.journal.dialect !== 'postgresql') problems.push(`drizzle-pg/: dialect ${postgres.journal.dialect}`);
  problems.push(...filesMatchJournal(sqlite, 'drizzle/'), ...filesMatchJournal(postgres, 'drizzle-pg/'));

  const [baseline, ...pgAfter] = postgres.journal.entries;
  const point = sqlite.journal.entries.findIndex((entry) => entry.tag === equivalence.sqlite);
  if (!baseline || baseline.tag !== equivalence.baseline) {
    problems.push(`drizzle-pg/: the first migration is ${baseline?.tag ?? 'missing'}, not the baseline ${equivalence.baseline}`);
    return problems;
  }
  if (point === -1) {
    problems.push(`drizzle/: no migration ${equivalence.sqlite}, which the baseline equals`);
    return problems;
  }
  const equal = sqlite.journal.entries[point];
  // The same `when`, so a database at the baseline is as new as one at the
  // SQLite migration; the same idx, so drizzle-kit numbers the next PostgreSQL
  // migration like the next SQLite one.
  if (baseline.when !== equal.when) problems.push(`drizzle-pg/${baseline.tag}: when ${baseline.when}, ${equal.tag} has ${equal.when}`);
  if (baseline.idx !== equal.idx) problems.push(`drizzle-pg/${baseline.tag}: idx ${baseline.idx}, ${equal.tag} has ${equal.idx}`);

  const sqliteAfter = sqlite.journal.entries.slice(point + 1);
  const pgTags = new Set(pgAfter.map((entry) => entry.tag));
  const sqliteTags = new Set(sqliteAfter.map((entry) => entry.tag));
  for (const entry of sqliteAfter) if (!pgTags.has(entry.tag)) problems.push(`${entry.tag}: in drizzle/ only`);
  for (const entry of pgAfter) if (!sqliteTags.has(entry.tag)) problems.push(`${entry.tag}: in drizzle-pg/ only`);
  const paired = sqliteAfter.filter((entry) => pgTags.has(entry.tag)).map((entry) => entry.tag);
  const pgPaired = pgAfter.filter((entry) => sqliteTags.has(entry.tag)).map((entry) => entry.tag);
  if (paired.join(',') !== pgPaired.join(',')) problems.push(`order: ${paired.join(', ')} in drizzle/, ${pgPaired.join(', ')} in drizzle-pg/`);
  for (const entry of pgAfter) {
    const twin = sqliteAfter.find((candidate) => candidate.tag === entry.tag);
    if (!twin) continue;
    if (entry.when !== twin.when) problems.push(`${entry.tag}: when ${twin.when} in drizzle/, ${entry.when} in drizzle-pg/`);
    if (entry.idx !== twin.idx) problems.push(`${entry.tag}: idx ${twin.idx} in drizzle/, ${entry.idx} in drizzle-pg/`);
  }
  for (const entry of postgres.journal.entries) {
    if (!entry.breakpoints) problems.push(`drizzle-pg/${entry.tag}: breakpoints off`);
  }
  problems.push(
    ...strictlyGrowing(sqlite.journal.entries.slice(point), 'drizzle/'),
    ...strictlyGrowing(postgres.journal.entries, 'drizzle-pg/')
  );
  return problems;
}

const sqlite = readFolder('drizzle');
const postgres = readFolder('drizzle-pg');
const equivalence = JSON.parse(readFileSync(resolve(ROOT, 'drizzle-pg/meta/_sqlite-equivalence.json'), 'utf8')) as Equivalence;

describe('SQLite and PostgreSQL migrations', () => {
  it('start the PostgreSQL migrations from a baseline equal to a SQLite migration', () => {
    expect(postgres.journal.entries[0].tag).toBe(equivalence.baseline);
    expect(sqlite.journal.entries.map((entry) => entry.tag)).toContain(equivalence.sqlite);
  });

  it('come in pairs after the baseline', () => {
    expect(migrationPairProblems(sqlite, postgres, equivalence)).toEqual([]);
  });

  describe('the check', () => {
    const entry = (idx: number, tag: string, when: number): JournalEntry => ({ idx, version: '7', when, tag, breakpoints: true });
    const folder = (dialect: string, entries: JournalEntry[]): Folder => ({
      journal: { version: '7', dialect, entries },
      sqlFiles: entries.map((e) => `${e.tag}.sql`).sort(),
    });
    const sqliteFolder = folder('sqlite', [entry(51, '0051_a', 100), entry(52, '0052_b', 200), entry(53, '0053_c', 300), entry(54, '0054_d', 400)]);
    const pgFolder = folder('postgresql', [entry(52, '0000_baseline', 200), entry(53, '0053_c', 300), entry(54, '0054_d', 400)]);
    const point = { baseline: '0000_baseline', sqlite: '0052_b' };

    it('accepts folders in step', () => {
      expect(migrationPairProblems(sqliteFolder, pgFolder, point)).toEqual([]);
    });

    it('reports a migration without its twin, in either folder', () => {
      const lonely = folder('sqlite', [...sqliteFolder.journal.entries, entry(55, '0055_e', 500)]);
      expect(migrationPairProblems(lonely, pgFolder, point)).toEqual(['0055_e: in drizzle/ only']);
      const extra = folder('postgresql', [...pgFolder.journal.entries, entry(55, '0055_e', 500)]);
      expect(migrationPairProblems(sqliteFolder, extra, point)).toEqual(['0055_e: in drizzle-pg/ only']);
    });

    it('reports twins whose when, idx or order differ', () => {
      const shifted = folder('postgresql', [entry(52, '0000_baseline', 200), entry(53, '0053_c', 300), entry(55, '0054_d', 401)]);
      expect(migrationPairProblems(sqliteFolder, shifted, point)).toEqual([
        '0054_d: when 400 in drizzle/, 401 in drizzle-pg/',
        '0054_d: idx 54 in drizzle/, 55 in drizzle-pg/',
      ]);
      const swapped = folder('postgresql', [entry(52, '0000_baseline', 200), entry(54, '0054_d', 400), entry(53, '0053_c', 300)]);
      expect(migrationPairProblems(sqliteFolder, swapped, point)).toEqual([
        'order: 0053_c, 0054_d in drizzle/, 0054_d, 0053_c in drizzle-pg/',
        'drizzle-pg/0053_c: when 300 is not after 0054_d (400)',
      ]);
    });

    it('reports a baseline that does not match its SQLite migration', () => {
      const early = folder('postgresql', [entry(0, '0000_baseline', 150), ...pgFolder.journal.entries.slice(1)]);
      expect(migrationPairProblems(sqliteFolder, early, point)).toEqual([
        'drizzle-pg/0000_baseline: when 150, 0052_b has 200',
        'drizzle-pg/0000_baseline: idx 0, 0052_b has 52',
      ]);
      expect(migrationPairProblems(sqliteFolder, pgFolder, { baseline: '0000_baseline', sqlite: '0099_z' })).toEqual([
        'drizzle/: no migration 0099_z, which the baseline equals',
      ]);
    });

    it('reports SQL files and journal entries that do not match', () => {
      const orphan = { ...pgFolder, sqlFiles: [...pgFolder.sqlFiles, '0055_orphan.sql'].filter((file) => file !== '0053_c.sql') };
      expect(migrationPairProblems(sqliteFolder, orphan, point)).toEqual([
        'drizzle-pg/0053_c.sql: missing',
        'drizzle-pg/0055_orphan.sql: not in the journal',
      ]);
    });
  });
});
