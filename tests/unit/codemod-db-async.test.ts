/**
 * The db-async codemod (scripts/codemods/db-async): fixture files, kept in
 * memory under src/ and tests/, are analysed and rewritten against the real
 * database facade and schema, then rewritten again to check that a second
 * run changes nothing.
 */
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeClosure, type Closure, type RiskKind } from '../../scripts/codemods/db-async/closure';
import { loadProgram, REPO_ROOT } from '../../scripts/codemods/db-async/project';
import { applyEdits, EditConflictError, rewrite, type RewriteResult } from '../../scripts/codemods/db-async/rewrite';
import { pathFilter } from '../../scripts/codemods/db-async/transform';

const DIR = 'src/__codemod_fixtures__';
const TEST_DIR = 'tests/__codemod_fixtures__';

const FIXTURES: Record<string, string> = {
  [`${DIR}/terminals.ts`]: `import db from "@/src/lib/db";
import { settings, users } from "@/src/lib/db/schema";
import { eq } from "drizzle-orm";

export function readSetting(key: string) {
  return db.select().from(settings).where(eq(settings.key, key)).get();
}

export function listUsers() {
  return db.select().from(users).all();
}

export function deleteSetting(key: string): void {
  db.delete(settings).where(eq(settings.key, key)).run();
}

export function firstOfFive() {
  return db.select().from(users).limit(5).get();
}

export function insertReturning(key: string): number {
  const row = db.insert(settings).values({ key, value: "1", updatedAt: "now" }).returning({ key: settings.key }).get();
  return row.key.length;
}

export function assertedReturning(key: string): string {
  return db.insert(settings).values({ key, value: "1", updatedAt: "now" }).returning({ key: settings.key }).get()!.key;
}

export function settingValue(key: string): string | null {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
}

export function multiline() {
  return db
    .select()
    .from(users)
    .where(eq(users.id, 1))
    .get();
}
`,
  [`${DIR}/propagation.ts`]: `import db from "@/src/lib/db";
import { users } from "@/src/lib/db/schema";
import { eq } from "drizzle-orm";
import { readSetting } from "./terminals";

function countUsers(): number {
  return db.select().from(users).all().length;
}

export function hasUsers(): boolean {
  return countUsers() > 0;
}

export function label(): string {
  return hasUsers() ? "some" : "none";
}

export async function alreadyAsync(): Promise<number> {
  return countUsers();
}

export const byId = (id: number) => db.select().from(users).where(eq(users.id, id)).get();

export function nameOf(id: number) {
  return byId(id)?.username;
}

export function fireAndForget(): void {
  void countUsers();
}

export function overloaded(a: string): number;
export function overloaded(a: number): number;
export function overloaded(a: string | number): number {
  return countUsers() + String(a).length;
}

export function useOverload() {
  return overloaded("x");
}

export function crossFile() {
  return readSetting("k");
}

export function untouched(a: number): number {
  return a + 1;
}

export type Count = ReturnType<typeof countUsers>;

export function immediately() {
  const total = (() => countUsers())();
  return total;
}
`,
  [`${DIR}/transactions.ts`]: `import db from "@/src/lib/db";
import { settings } from "@/src/lib/db/schema";
import { eq } from "drizzle-orm";

export function swap(a: string, b: string): number {
  return db.transaction((tx): number => {
    const first = tx.select().from(settings).where(eq(settings.key, a)).get();
    if (!first) return 0;
    tx.update(settings).set({ value: b }).where(eq(settings.key, a)).run();
    return 1;
  }, { behavior: "immediate" });
}
`,
  [`${DIR}/types.ts`]: `import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "@/src/lib/db/schema";
import db from "@/src/lib/db";
import { settings } from "@/src/lib/db/schema";

type SyncDatabase = BaseSQLiteDatabase<"sync", unknown, typeof schema>;

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type Reader = Pick<typeof db, "select">;

export function count(database: SyncDatabase = db): number {
  return database.select().from(settings).all().length;
}

export function clear(tx: DbTransaction): void {
  tx.delete(settings).run();
}

export function useReader(reader: Reader) {
  return reader.select().from(settings).all();
}
`,
  [`${DIR}/risky.ts`]: `import db from "@/src/lib/db";
import { users } from "@/src/lib/db/schema";
import { eq } from "drizzle-orm";

function isActive(id: number): boolean {
  return !!db.select().from(users).where(eq(users.id, id)).get();
}

export function activeIds(ids: number[]): number[] {
  return ids.filter((id) => isActive(id));
}

export class Counter {
  get count(): number {
    return db.select().from(users).all().length;
  }
}

export function start(): void {
  process.on("exit", () => {
    db.delete(users).run();
  });
  setInterval(() => {
    isActive(1);
  }, 1000);
}

export function guard(id: number): void {
  if (!isActive(id)) throw new Error("inactive");
}

export function withDefault(active: boolean = isActive(1)): boolean {
  return active;
}

export function deleted(): number {
  const result = db.delete(users).run();
  return (result as unknown as { changes: number }).changes;
}

export function isUser(value: unknown): value is { id: number } {
  return typeof value === "object" && !!db.select().from(users).get();
}
`,
  [`${DIR}/sql-helpers.ts`]: `import { asc, desc, like, sql } from "drizzle-orm";
import db from "@/src/lib/db";
import { users } from "@/src/lib/db/schema";

export async function search(term: string) {
  return db.select().from(users).where(like(users.name, \`%\${term}%\`)).orderBy(asc(users.id), desc(users.name)).all();
}

export const prefixed = like(users.email, "admin%");
export const lowered = (name: string) => sql\`lower(\${users.username}) = \${name}\`;
export const fallback = sql\`ifnull(\${users.name}, '')\`;
export const never = sql\`0\`;
export const escaped = (pattern: string) => sql\`\${users.email} LIKE \${pattern} ESCAPE '\\\\'\`;
export const linkUser = sql<string | null>\`case when json_valid(\${users.name}) then cast(json_extract(\${users.name}, '$.link.userId') as text) end\`;
export const tagged = (tags: string[]) => sql\`exists (select 1 from json_each(case when json_valid(\${users.name}) then \${users.name} else '[]' end) where json_each.value in (\${sql.join(
  tags.map((tag) => sql\`\${tag}\`),
  sql\`, \`
)}))\`;
export const leftover = sql\`strftime('%s', \${users.name})\`;
`,
  [`${DIR}/generic.ts`]: `import { AsyncLocalStorage } from "node:async_hooks";
import db from "@/src/lib/db";
import { users } from "@/src/lib/db/schema";

const storage = new AsyncLocalStorage<number>();

function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function countUsers(): number {
  return db.select().from(users).all().length;
}

export function safeCount(): number {
  return safely(() => countUsers(), 0);
}

export function inContext(): number {
  return storage.run(1, () => countUsers());
}
`,
  [`${DIR}/interfaces.ts`]: `import db from "@/src/lib/db";
import { users } from "@/src/lib/db/schema";

interface Provider {
  count(): number;
}

const dbProvider: Provider = {
  count() {
    return db.select().from(users).all().length;
  },
};

const constantProvider: Provider = { count: () => 1 };

export function total(providers: Provider[]): number {
  let sum = 0;
  for (const provider of providers) sum += provider.count();
  return sum;
}

export const providers = [dbProvider, constantProvider];
`,
  [`${DIR}/forwarding.ts`]: `import db from "@/src/lib/db";
import { users } from "@/src/lib/db/schema";

type Hook = (id: number) => void;

function runHook(hook: Hook | undefined, id: number): void {
  hook?.(id);
}

export function withDbHook(id: number): void {
  runHook((user) => {
    db.delete(users).run();
    void user;
  }, id);
}

export function passOn(hook: (id: number) => void): void {
  runHook(hook, 2);
}
`,
  [`${TEST_DIR}/sample.test.ts`]: `import { expect, it } from "vitest";
import { listUsers } from "@/src/__codemod_fixtures__/terminals";

it("lists users", () => {
  expect(listUsers()).toEqual([]);
});
`,
  // An excluded file: read for its call sites, never rewritten.
  ['src/lib/db/__codemod_fixture__.ts']: `import { listUsers } from "@/src/__codemod_fixtures__/terminals";

export function excludedCaller(): number {
  return listUsers().length;
}
`,
};

function overlayOf(files: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(files).map(([file, text]) => [resolve(REPO_ROOT, file), text]));
}

function run(files: Record<string, string>): { closure: Closure; result: RewriteResult; out: Record<string, string> } {
  const overlay = overlayOf(files);
  const program = loadProgram({ rootNames: [...overlay.keys()], overlay });
  const closure = analyzeClosure(program);
  const result = rewrite(closure, {
    include: (file) => file.startsWith(`${DIR}/`) || file.startsWith(`${TEST_DIR}/`) || file.startsWith('src/lib/db/__codemod'),
  });
  const out: Record<string, string> = { ...files };
  for (const file of result.files) {
    if (file.error) throw new Error(`${file.file}: ${file.error}`);
    out[file.file] = file.after;
  }
  return { closure, result, out };
}

let first: ReturnType<typeof run>;

function output(name: string): string {
  return first.out[name.includes('/') ? name : `${DIR}/${name}`];
}

function findings(kind: RiskKind, file?: string) {
  return first.result.findings.filter((f) => f.kind === kind && (!file || f.file === `${DIR}/${file}`));
}

beforeAll(() => {
  first = run(FIXTURES);
}, 240_000);

describe('terminals', () => {
  it('awaits the builder instead of .all() and .run(), and imports appDb', () => {
    const text = output('terminals.ts');
    expect(text).toContain('import { appDb } from "@/src/lib/db";');
    expect(text).toContain('import { first } from "@/src/lib/db/ops";');
    expect(text).not.toMatch(/import db\b/);
    expect(text).toContain('export async function listUsers() {\n  return await appDb.select().from(users);\n}');
    expect(text).toContain(
      'export async function deleteSetting(key: string): Promise<void> {\n  await appDb.delete(settings).where(eq(settings.key, key));\n}'
    );
  });

  it('turns .get() into await first(builder.limit(1)), keeping an existing limit', () => {
    const text = output('terminals.ts');
    expect(text).toContain('return await first(appDb.select().from(settings).where(eq(settings.key, key)).limit(1));');
    expect(text).toContain('return await first(appDb.select().from(users).limit(5));');
    expect(text).toContain('return (await first(appDb.select().from(settings).where(eq(settings.key, key)).limit(1)))?.value ?? null;');
  });

  it('keeps the non-undefined type of .returning().get()', () => {
    expect(output('terminals.ts')).toContain(
      'const row = (await first(appDb.insert(settings).values({ key, value: "1", updatedAt: "now" }).returning({ key: settings.key })))!;'
    );
  });

  it('does not add a second non-null assertion to .get()!', () => {
    expect(output('terminals.ts')).toContain(
      'return (await first(appDb.insert(settings).values({ key, value: "1", updatedAt: "now" }).returning({ key: settings.key })))!.key;'
    );
  });

  it('keeps the layout of a multi-line chain', () => {
    expect(output('terminals.ts')).toContain(
      'return await first(appDb\n    .select()\n    .from(users)\n    .where(eq(users.id, 1))\n    .limit(1));'
    );
  });
});

describe('propagation', () => {
  it('makes callers async to a fixpoint, with Promise return types and precedence kept', () => {
    const text = output('propagation.ts');
    expect(text).toContain('async function countUsers(): Promise<number> {\n  return (await appDb.select().from(users)).length;');
    expect(text).toContain('export async function hasUsers(): Promise<boolean> {\n  return await countUsers() > 0;');
    expect(text).toContain('export async function label(): Promise<string> {\n  return await hasUsers() ? "some" : "none";');
    expect(text).toContain('export async function nameOf(id: number) {\n  return (await byId(id))?.username;');
    expect(text).toContain('export async function crossFile() {\n  return await readSetting("k");');
  });

  it('awaits inside functions that are already async without touching their signature', () => {
    expect(output('propagation.ts')).toContain('export async function alreadyAsync(): Promise<number> {\n  return await countUsers();');
  });

  it('converts arrow functions, immediately invoked functions and overloads', () => {
    const text = output('propagation.ts');
    expect(text).toContain('export const byId = async (id: number) => await first(appDb.select().from(users).where(eq(users.id, id)).limit(1));');
    expect(text).toContain('const total = await (async () => await countUsers())();');
    expect(text).toContain('export function overloaded(a: string): Promise<number>;\nexport function overloaded(a: number): Promise<number>;');
    expect(text).toContain('export async function overloaded(a: string | number): Promise<number> {');
    expect(text).toContain('export async function useOverload() {\n  return await overloaded("x");');
  });

  it('turns void f() into await f() and lists it', () => {
    expect(output('propagation.ts')).toContain('export async function fireAndForget(): Promise<void> {\n  await countUsers();');
    expect(findings('void-call', 'propagation.ts')).toHaveLength(1);
  });

  it('wraps ReturnType of a function that became async in Awaited', () => {
    expect(output('propagation.ts')).toContain('export type Count = Awaited<ReturnType<typeof countUsers>>;');
  });

  it('leaves functions that do not reach the database alone', () => {
    expect(output('propagation.ts')).toContain('export function untouched(a: number): number {');
  });

  it('records why a function is in the closure and who calls it', () => {
    const member = [...first.closure.members.values()].find((m) => m.name === 'hasUsers');
    expect(member?.converts).toBe(true);
    expect(member?.reasons.map((r) => `${r.kind}:${r.detail}`)).toContain('calls:countUsers');
    expect(member?.callers.some((c) => c.member?.name === 'label')).toBe(true);
  });
});

describe('transactions', () => {
  it('awaits appDb.transaction with an async callback, keeping options, and avoids a local name clash', () => {
    const text = output('transactions.ts');
    expect(text).toContain('return await appDb.transaction(async (tx): Promise<number> => {');
    expect(text).toContain('const first = await dbFirst(tx.select().from(settings).where(eq(settings.key, a)).limit(1));');
    expect(text).toContain('await tx.update(settings).set({ value: b }).where(eq(settings.key, a));');
    expect(text).toContain('}, { behavior: "immediate" });');
    expect(text).toContain('import { first as dbFirst } from "@/src/lib/db/ops";');
  });
});

describe('types', () => {
  it('replaces the synchronous database types with @/src/lib/db/types and drops the imports they used', () => {
    const text = output('types.ts');
    expect(text).toContain('import type { AppDb, AppTx, DbExecutor } from "@/src/lib/db/types";');
    expect(text).not.toContain('BaseSQLiteDatabase');
    expect(text).not.toContain('import type * as schema');
    expect(text).not.toContain('type SyncDatabase');
    expect(text).not.toContain('type DbTransaction');
    expect(text).toContain('export type Reader = Pick<AppDb, "select">;');
    expect(text).toContain('export async function count(database: DbExecutor = appDb): Promise<number> {');
    expect(text).toContain('export async function clear(tx: AppTx): Promise<void> {\n  await tx.delete(settings);');
  });
});

describe('risky contexts', () => {
  it('awaits inside array callbacks without making them async, and converts the function around them', () => {
    const text = output('risky.ts');
    expect(text).toContain('export async function activeIds(ids: number[]): Promise<number[]> {\n  return ids.filter((id) => await isActive(id));');
    expect(findings('array-callback', 'risky.ts')).toHaveLength(1);
  });

  it('reports accessors, exit hooks, timers, parameter defaults, type predicates and used .run() results', () => {
    expect(findings('accessor', 'risky.ts')).toHaveLength(1);
    expect(findings('exit-handler', 'risky.ts')).toHaveLength(1);
    expect(findings('void-callback', 'risky.ts')).toHaveLength(1);
    expect(findings('parameter-default', 'risky.ts')).toHaveLength(1);
    expect(findings('type-predicate', 'risky.ts')).toHaveLength(1);
    expect(findings('run-result', 'risky.ts')).toHaveLength(1);
    for (const kind of ['accessor', 'exit-handler', 'void-callback', 'parameter-default', 'type-predicate', 'run-result'] as const) {
      expect(findings(kind, 'risky.ts')[0].manual, kind).toBe(true);
    }
    const text = output('risky.ts');
    expect(text).toContain('get count(): number {\n    return (await appDb.select().from(users)).length;');
    expect(text).toContain('export function isUser(value: unknown): value is { id: number } {');
  });

  it('awaits security predicates in conditions and lists them for review', () => {
    expect(output('risky.ts')).toContain('export async function guard(id: number): Promise<void> {\n  if (!await isActive(id)) throw new Error("inactive");');
    const review = findings('boolean-context', 'risky.ts');
    expect(review.length).toBeGreaterThanOrEqual(1);
    expect(review.every((f) => !f.manual)).toBe(true);
  });

  it('reports call sites in excluded files and never rewrites them', () => {
    expect(first.result.files.map((f) => f.file)).not.toContain('src/lib/db/__codemod_fixture__.ts');
    const excluded = first.result.findings.filter((f) => f.kind === 'excluded-file');
    expect(excluded.map((f) => f.file)).toContain('src/lib/db/__codemod_fixture__.ts');
  });
});

describe('dialect-neutral SQL', () => {
  it('moves asc/desc to ops and turns like() into containsText/likeText', () => {
    const text = output('sql-helpers.ts');
    expect(text).toContain('import { sql } from "drizzle-orm";');
    expect(text).toMatch(/import \{ asc, containsText, desc, jsonArrayIncludesAny, jsonTextAt, likeText, lowerEquals, sqlFalse \} from "@\/src\/lib\/db\/ops";/);
    expect(text).toContain('.where(containsText(users.name, term)).orderBy(asc(users.id), desc(users.name));');
    expect(text).toContain('export const prefixed = likeText(users.email, "admin%");');
    expect(findings('like-semantics', 'sql-helpers.ts')).toHaveLength(1);
  });

  it('rewrites the SQLite-only templates the plan names', () => {
    const text = output('sql-helpers.ts');
    expect(text).toContain('export const lowered = (name: string) => lowerEquals(users.username, name);');
    expect(text).toContain("export const fallback = sql`coalesce(${users.name}, '')`;");
    expect(text).toContain('export const never = sqlFalse();');
    expect(text).toContain('export const escaped = (pattern: string) => likeText(users.email, pattern);');
    expect(text).toContain('export const linkUser = sql<string | null>`${jsonTextAt(users.name, ["link", "userId"])}`;');
    expect(text).toContain('export const tagged = (tags: string[]) => jsonArrayIncludesAny(users.name, tags);');
  });

  it('reports SQLite-only SQL it cannot translate', () => {
    expect(findings('sqlite-sql', 'sql-helpers.ts').map((f) => f.code)).toEqual([expect.stringContaining('strftime')]);
  });
});

describe('callbacks and signatures', () => {
  it('makes a generic wrapper of this repository await its callback', () => {
    const text = output('generic.ts');
    expect(text).toContain('async function safely<T>(fn: () => Promise<T>, fallback: T): Promise<T> {\n  try {\n    return await fn();');
    expect(text).toContain('return await safely(async () => await countUsers(), 0);');
    expect(findings('generic-wrapper', 'generic.ts').length).toBeGreaterThanOrEqual(1);
  });

  it('awaits a library call whose result follows the callback (AsyncLocalStorage.run)', () => {
    expect(output('generic.ts')).toContain('return await storage.run(1, async () => await countUsers());');
  });

  it('changes an interface member and every implementation, and awaits calls through it', () => {
    const text = output('interfaces.ts');
    expect(text).toContain('  count(): Promise<number>;');
    expect(text).toContain('  async count() {\n    return (await appDb.select().from(users)).length;');
    expect(text).toContain('const constantProvider: Provider = { count: async () => 1 };');
    expect(text).toContain('for (const provider of providers) sum += await provider.count();');
    expect(text).toContain('export async function total(providers: Provider[]): Promise<number> {');
    expect(findings('signature-change', 'interfaces.ts')).toHaveLength(1);
  });

  it('follows function values passed on into a signature that changed', () => {
    const text = output('forwarding.ts');
    expect(text).toContain('type Hook = (id: number) => Promise<void>;');
    expect(text).toContain('async function runHook(hook: Hook | undefined, id: number): Promise<void> {\n  await hook?.(id);');
    expect(text).toContain('export async function passOn(hook: (id: number) => Promise<void>): Promise<void> {\n  await runHook(hook, 2);');
  });
});

describe('tests scope', () => {
  it('converts test callbacks, which may be async', () => {
    expect(output(`${TEST_DIR}/sample.test.ts`)).toContain('it("lists users", async () => {\n  expect(await listUsers()).toEqual([]);');
  });
});

describe('re-running', () => {
  it('changes nothing the second time, and still reports the manual sites', () => {
    const second = run(first.out);
    expect(second.result.files.filter((f) => f.after !== f.before).map((f) => f.file)).toEqual([]);
    const pending = second.result.findings.filter((f) => f.kind === 'pending-manual').map((f) => f.file);
    expect(pending).toContain(`${DIR}/risky.ts`);
  }, 240_000);
});

describe('code merged from an older base (--await-unawaited)', () => {
  const RERUN = {
    [`${DIR}/rerun.ts`]: `import { appDb } from "@/src/lib/db";
import { settings } from "@/src/lib/db/schema";

export async function touch(): Promise<void> {
  await appDb.delete(settings);
}

export async function exists(): Promise<boolean> {
  return (await appDb.select().from(settings)).length > 0;
}

export function legacy(): void {
  touch();
}

export function legacyCheck(): string {
  return exists() ? "yes" : "no";
}
`,
  };

  function analyze(awaitUnawaited: boolean) {
    const overlay = overlayOf(RERUN);
    const closure = analyzeClosure(loadProgram({ rootNames: [...overlay.keys()], overlay }), { awaitUnawaited });
    const result = rewrite(closure, { include: (file) => file.startsWith(`${DIR}/`) });
    return { result, text: result.files.find((f) => f.file === `${DIR}/rerun.ts`)?.after };
  }

  it('reports dropped and misused promises by default and changes nothing', () => {
    const { result, text } = analyze(false);
    expect(text).toBeUndefined();
    expect(result.findings.filter((f) => f.file === `${DIR}/rerun.ts`).map((f) => f.kind).sort()).toEqual(['floating-async-call', 'unawaited-async-call']);
  }, 120_000);

  it('awaits them, and makes the callers async, when asked', () => {
    const { text } = analyze(true);
    expect(text).toContain('export async function legacy(): Promise<void> {\n  await touch();');
    expect(text).toContain('export async function legacyCheck(): Promise<string> {\n  return await exists() ? "yes" : "no";');
  }, 120_000);
});

describe('applyEdits', () => {
  it('orders insertions at one position outside-in and applies replacements after them', () => {
    const text = 'f(x)';
    expect(
      applyEdits(text, [
        { start: 0, end: 0, text: '(await ', order: -10 },
        { start: 0, end: 0, text: 'await first(', order: -20 },
        { start: 0, end: 1, text: 'g', order: 0 },
        { start: 4, end: 4, text: ')', order: 10 },
      ])
    ).toBe('await first((await g(x))');
  });

  it('refuses overlapping replacements', () => {
    expect(() => applyEdits('abcdef', [{ start: 0, end: 3, text: 'x', order: 0 }, { start: 2, end: 4, text: 'y', order: 0 }])).toThrow(EditConflictError);
  });
});

describe('path filters', () => {
  it('selects by scope, directory prefix and glob', () => {
    const production = pathFilter([], 'production');
    expect(production('src/lib/audit.ts')).toBe(true);
    expect(production('proxy.ts')).toBe(true);
    expect(production('tests/unit/a.test.ts')).toBe(false);
    expect(production('scripts/db/generate-pg-schema.ts')).toBe(false);
    const models = pathFilter(['src/lib/models'], 'production');
    expect(models('src/lib/models/user.ts')).toBe(true);
    expect(models('src/lib/models-extra.ts')).toBe(false);
    const glob = pathFilter(['ee/**/store.ts'], 'all');
    expect(glob('ee/saml/store.ts')).toBe(true);
    expect(glob('ee/saml/providers.ts')).toBe(false);
  });
});
