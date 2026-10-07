/**
 * The dialect-neutral helpers (src/lib/db/ops.ts), the dialect detection
 * (src/lib/db/dialect.ts) and the cluster lock (src/lib/db/locks.ts). The
 * queries run on the test database (SQLite, or PostgreSQL in the postgres
 * project); the SQL of the PostgreSQL forms is checked on both.
 */
import { eq, sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db';
import { forwardAuthAccess, settings, users } from '../../src/lib/db/schema';
import {
  asc,
  containsText,
  desc,
  escapeLikePattern,
  execRaw,
  first,
  isConstraintViolation,
  isReadOnlyError,
  isUniqueViolation,
  jsonArrayIncludesAny,
  jsonTextAt,
  likeText,
  lowerEquals,
  resyncIdentity,
  sqlFalse,
  sqlTrue,
} from '../../src/lib/db/ops';
import { getDialect, isPostgresUrl } from '../../src/lib/db/dialect';
import { isClusterLockHeld, withClusterLock } from '../../src/lib/db/locks';

const NOW = '2026-01-01T00:00:00.000Z';

afterEach(() => {
  vi.unstubAllEnvs();
});

async function addUser(db: TestDb, email: string, name: string | null, id?: number) {
  const [user] = await db.insert(users).values({ id, email, name, createdAt: NOW, updatedAt: NOW }).returning();
  return user;
}

async function failure(promise: PromiseLike<unknown>): Promise<unknown> {
  return Promise.resolve(promise).then(() => { throw new Error('expected a rejection'); }, (error: unknown) => error);
}

describe('first', () => {
  it('returns the first row, or undefined when there is none', async () => {
    const db = createTestDb();
    await addUser(db, 'a@example.com', 'A');
    await addUser(db, 'b@example.com', 'B');
    expect(await first(db.select({ email: users.email }).from(users).orderBy(users.id))).toEqual({ email: 'a@example.com' });
    expect(await first(db.select().from(users).where(eq(users.email, 'nobody@example.com')))).toBeUndefined();
  });
});

describe('ordering', () => {
  it('puts NULLs first ascending and last descending, as SQLite does, unless asked otherwise', async () => {
    const db = createTestDb();
    await addUser(db, 'b@example.com', 'b');
    await addUser(db, 'null@example.com', null);
    await addUser(db, 'a@example.com', 'a');
    const names = async (order: ReturnType<typeof asc>) =>
      (await db.select({ name: users.name }).from(users).orderBy(order, users.id)).map((row) => row.name);
    expect(await names(asc(users.name))).toEqual([null, 'a', 'b']);
    expect(await names(desc(users.name))).toEqual(['b', 'a', null]);
    expect(await names(asc(users.name, { nulls: 'last' }))).toEqual(['a', 'b', null]);
    expect(await names(desc(users.name, { nulls: 'first' }))).toEqual([null, 'b', 'a']);
  });
});

describe('text matching', () => {
  it('finds text literally, ignoring the case of ASCII letters', async () => {
    const db = createTestDb();
    for (const [key, value] of [['1', 'Alpha Beta'], ['2', '100% sure'], ['3', 'snake_case'], ['4', 'back\\slash'], ['5', 'snakeXcase']]) {
      await db.insert(settings).values({ key, value, updatedAt: NOW });
    }
    const matching = async (condition: ReturnType<typeof containsText>) =>
      (await db.select({ key: settings.key }).from(settings).where(condition).orderBy(settings.key)).map((row) => row.key);
    expect(await matching(containsText(settings.value, 'alpha b'))).toEqual(['1']);
    expect(await matching(containsText(settings.value, '0%'))).toEqual(['2']);
    expect(await matching(containsText(settings.value, '_'))).toEqual(['3']);
    expect(await matching(containsText(settings.value, 'k\\s'))).toEqual(['4']);
    expect(await matching(likeText(settings.value, 'SNAKE_case'))).toEqual(['3', '5']);
    expect(await matching(likeText(settings.value, `${escapeLikePattern('snake_')}%`))).toEqual(['3']);
    expect(escapeLikePattern('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });

  it('compares lowercased column values with an already lowercase value', async () => {
    const db = createTestDb();
    await addUser(db, 'Mixed.Case@Example.com', null);
    expect(await first(db.select({ id: users.id }).from(users).where(lowerEquals(users.email, 'mixed.case@example.com')))).toEqual({ id: 1 });
    expect(await first(db.select({ id: users.id }).from(users).where(lowerEquals(users.email, 'Mixed.Case@Example.com')))).toBeUndefined();
  });
});

describe('JSON stored as text', () => {
  it('matches JSON arrays holding any of the values, and nothing for invalid JSON or no values', async () => {
    const db = createTestDb();
    for (const [key, value] of [['1', '["web","prod"]'], ['2', '["db"]'], ['3', 'not json'], ['4', '[]']]) {
      await db.insert(settings).values({ key, value, updatedAt: NOW });
    }
    const matching = async (values: string[]) =>
      (await db.select({ key: settings.key }).from(settings).where(jsonArrayIncludesAny(settings.value, values)).orderBy(settings.key))
        .map((row) => row.key);
    expect(await matching(['prod'])).toEqual(['1']);
    expect(await matching(['db', 'web'])).toEqual(['1', '2']);
    expect(await matching(['none'])).toEqual([]);
    expect(await matching([])).toEqual([]);
  });

  it('reads a value at a path as text, NULL when the JSON is invalid or has nothing there', async () => {
    const db = createTestDb();
    for (const [key, value] of [['1', '{"link":{"userId":5}}'], ['2', '{"link":{"userId":"7"}}'], ['3', 'garbage'], ['4', '[1,{"a":"b"}]']]) {
      await db.insert(settings).values({ key, value, updatedAt: NOW });
    }
    const values = async (path: (string | number)[]) =>
      (await db.select({ value: jsonTextAt(settings.value, path) }).from(settings).orderBy(settings.key)).map((row) => row.value);
    expect(await values(['link', 'userId'])).toEqual(['5', '7', null, null]);
    expect(await values([1, 'a'])).toEqual([null, null, null, 'b']);
    expect(() => jsonTextAt(settings.value, ["a') or 1=1 --"])).toThrow(/Invalid JSON key/);
    expect(() => jsonTextAt(settings.value, [])).toThrow();
  });
});

describe('literals', () => {
  it('has a condition that matches nothing', async () => {
    const db = createTestDb();
    await db.insert(settings).values({ key: 'k', value: 'v', updatedAt: NOW });
    expect(await db.select().from(settings).where(sqlFalse())).toEqual([]);
  });
});

describe('driver errors', () => {
  it('recognises unique, other constraint and read-only violations through Drizzle\'s wrapping', async () => {
    const db = createTestDb();
    await addUser(db, 'taken@example.com', null);
    const unique = await failure(addUser(db, 'taken@example.com', null));
    expect(isUniqueViolation(unique)).toBe(true);
    expect(isConstraintViolation(unique)).toBe(true);
    expect(isReadOnlyError(unique)).toBe(false);

    const notNull = await failure(db.insert(settings).values({ key: 'k', value: null as unknown as string, updatedAt: NOW }));
    expect(isUniqueViolation(notNull)).toBe(false);
    expect(isConstraintViolation(notNull)).toBe(true);

    // The CHECK of drizzle/0017 refuses a grant naming neither a user nor a group.
    const check = await failure(db.insert(forwardAuthAccess).values({ proxyHostId: 1, userId: null, groupId: null, createdAt: NOW }));
    expect(isConstraintViolation(check)).toBe(true);

    let readOnly: unknown;
    await db.transaction(async (tx) => {
      readOnly = await failure(tx.insert(settings).values({ key: 'ro', value: 'x', updatedAt: NOW }));
    }, { readOnly: true });
    expect(isReadOnlyError(readOnly)).toBe(true);
    expect(isConstraintViolation(readOnly)).toBe(false);

    expect(isUniqueViolation(new Error('something else'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });

  it('recognises PostgreSQL error codes', () => {
    const wrapped = (code: string) => new Error('Failed query', { cause: Object.assign(new Error('driver'), { code }) });
    expect(isUniqueViolation(wrapped('23505'))).toBe(true);
    expect(isConstraintViolation(wrapped('23514'))).toBe(true);
    expect(isConstraintViolation(wrapped('42P01'))).toBe(false);
    expect(isReadOnlyError(wrapped('25006'))).toBe(true);
  });
});

describe('identity columns', () => {
  it('continues after explicit ids (nothing to resync on SQLite)', async () => {
    const db = createTestDb();
    await addUser(db, 'explicit@example.com', null, 100);
    await resyncIdentity(users, db);
    const next = await addUser(db, 'next@example.com', null);
    expect(next.id).toBe(101);
  });
});

describe('raw SQL', () => {
  it('returns object rows, binds parameters and joins the transaction it is given or runs in', async () => {
    const db = createTestDb();
    await db.insert(settings).values({ key: 'k', value: 'v', updatedAt: NOW });
    expect(await execRaw(sql`select ${settings.key} as key, ${settings.value} as value from ${settings} where ${settings.key} = ${'k'}`, db))
      .toEqual([{ key: 'k', value: 'v' }]);
    expect(await execRaw('update settings set value = \'w\'', db)).toEqual([]);

    await expect(db.transaction(async (tx) => {
      await tx.insert(settings).values({ key: 'uncommitted', value: '1', updatedAt: NOW });
      expect(await execRaw<{ n: number }>('select count(*) as n from settings', tx)).toEqual([{ n: 2 }]);
      expect(await execRaw<{ n: number }>('select count(*) as n from settings', db)).toEqual([{ n: 2 }]);
      throw new Error('undo');
    })).rejects.toThrow('undo');
    expect(await execRaw<{ n: number }>('select count(*) as n from settings', db)).toEqual([{ n: 1 }]);
  });
});

describe('dialect', () => {
  it('reads the dialect from DATABASE_URL, or DATABASE_DIALECT when it agrees', () => {
    expect(getDialect({})).toBe('sqlite');
    expect(getDialect({ DATABASE_URL: 'file:./data/ingressi.db' })).toBe('sqlite');
    expect(getDialect({ DATABASE_URL: ':memory:' })).toBe('sqlite');
    expect(getDialect({ DATABASE_URL: 'postgres://app@db.example.com/ingressi' })).toBe('postgres');
    expect(getDialect({ DATABASE_URL: 'postgresql://app@db.example.com/ingressi' })).toBe('postgres');
    expect(getDialect({ DATABASE_DIALECT: 'postgres' })).toBe('postgres');
    expect(getDialect({ DATABASE_DIALECT: 'PostgreSQL', DATABASE_URL: 'postgres://db.example.com/x' })).toBe('postgres');
    expect(getDialect({ DATABASE_DIALECT: 'sqlite', DATABASE_URL: 'file:./x.db' })).toBe('sqlite');
    expect(() => getDialect({ DATABASE_DIALECT: 'sqlite', DATABASE_URL: 'postgres://db.example.com/x' })).toThrow(/agree/);
    expect(() => getDialect({ DATABASE_DIALECT: 'postgres', DATABASE_URL: 'file:./x.db' })).toThrow(/agree/);
    expect(() => getDialect({ DATABASE_DIALECT: 'mysql' })).toThrow(/DATABASE_DIALECT/);
    expect(isPostgresUrl('POSTGRES://db.example.com/x')).toBe(true);
    expect(isPostgresUrl('file:postgres://x')).toBe(false);
  });

  it('gives the PostgreSQL forms of the helpers when the application runs on PostgreSQL', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://db.example.com/ingressi');
    const pg = new PgDialect();
    const render = (fragment: SQL) => {
      const { sql: text, params } = pg.sqlToQuery(fragment);
      return { sql: text, params };
    };
    expect(render(sqlFalse()).sql).toBe('false');
    expect(render(sqlTrue()).sql).toBe('true');
    expect(render(asc(settings.key)).sql).toMatch(/"key" asc nulls first$/);
    expect(render(asc(settings.key, { nulls: 'last' })).sql).toMatch(/"key" asc nulls last$/);
    expect(render(desc(settings.key)).sql).toMatch(/"key" desc nulls last$/);
    expect(render(desc(settings.key, { nulls: 'first' })).sql).toMatch(/"key" desc nulls first$/);
    expect(render(containsText(settings.value, '50%'))).toEqual({
      sql: expect.stringMatching(/"value" ilike \$1 escape '\\'$/),
      params: ['%50\\%%'],
    });
    const anyOf = render(jsonArrayIncludesAny(settings.value, ['a', 'b']));
    expect(anyOf.sql).toMatch(/is json array/);
    expect(anyOf.sql).toMatch(/jsonb_array_elements_text/);
    expect(anyOf.params).toEqual(['a', 'b']);
    expect(render(jsonTextAt(settings.value, ['link', 0, 'userId']))).toEqual({
      sql: expect.stringMatching(/is json then \(.*\)::jsonb #>> \$1::text\[\] end$/),
      params: ['{link,0,userId}'],
    });
    vi.unstubAllEnvs();
    expect(render(sqlFalse()).sql).toBe(getDialect() === 'postgres' ? 'false' : '0');
  });
});

describe('cluster locks', () => {
  it('runs holders of the same lock one after the other, in arrival order', async () => {
    const order: string[] = [];
    const holder = (name: string, delay: number) => withClusterLock('job', async () => {
      order.push(`${name} start`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      order.push(`${name} end`);
      return name;
    });
    const results = await Promise.all([holder('a', 15), holder('b', 1), holder('c', 1)]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(order).toEqual(['a start', 'a end', 'b start', 'b end', 'c start', 'c end']);
    expect(isClusterLockHeld('job')).toBe(false);
  });

  it('does not hold different locks against each other, is re-entrant and released on errors', async () => {
    const order: string[] = [];
    await Promise.all([
      withClusterLock('one', async () => {
        order.push('one');
        await new Promise((resolve) => setTimeout(resolve, 10));
        await withClusterLock('one', async () => { order.push('one again'); });
      }),
      withClusterLock('two', async () => { order.push('two'); }),
    ]);
    expect(order).toEqual(['one', 'two', 'one again']);
    await expect(withClusterLock('failing', async () => { throw new Error('nope'); })).rejects.toThrow('nope');
    expect(isClusterLockHeld('failing')).toBe(false);
    expect(await withClusterLock('failing', () => 'free again')).toBe('free again');
  });

  it('is refused inside a database transaction', async () => {
    const db = createTestDb();
    await db.transaction(async () => {
      await expect(withClusterLock('inside', () => 'x')).rejects.toThrow(/inside a database transaction/);
    });
    await expect(withClusterLock('', () => 'x')).rejects.toThrow(/lock name/);
  });
});
