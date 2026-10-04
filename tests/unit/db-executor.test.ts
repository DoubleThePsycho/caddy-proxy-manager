/**
 * The asynchronous database facade (src/lib/db/executor.ts) over SQLite:
 * results as the synchronous driver returned them, the process-wide FIFO
 * gate, ambient transactions that helpers using the default db join,
 * savepoints, rollback, escaped queries, BEGIN IMMEDIATE, read-only
 * transactions, the watchdog and whole-database work through the gate.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, sql, TransactionRollbackError } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db';
import { accounts, settings, users } from '../../src/lib/db/schema';
import {
  appDb,
  createSqliteExecutor,
  inTransaction,
  outsideTransaction,
  resolveDbTarget,
  setTransactionWatchdog,
  TransactionEscapeError,
} from '../../src/lib/db/executor';
import { execRaw, first, isReadOnlyError } from '../../src/lib/db/ops';
import type { AppTx, DbExecutor } from '../../src/lib/db/types';

const NOW = '2026-01-01T00:00:00.000Z';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Lets every pending callback and microtask run. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function put(db: DbExecutor, key: string, value: string) {
  return db.insert(settings).values({ key, value, updatedAt: NOW });
}

async function setting(db: DbExecutor, key: string): Promise<string | null> {
  return (await first(db.select().from(settings).where(eq(settings.key, key))))?.value ?? null;
}

/** The errors in `error`'s cause chain (Drizzle wraps what the driver callback throws). */
function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let current = error; current instanceof Error && chain.length < 5; current = current.cause) chain.push(current);
  return chain;
}

async function rejection(promise: PromiseLike<unknown>): Promise<unknown> {
  return Promise.resolve(promise).then(() => { throw new Error('expected a rejection'); }, (error: unknown) => error);
}

afterEach(() => {
  setTransactionWatchdog(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('queries', () => {
  it('returns rows, joins, relational queries, counts and inserted rows as the synchronous driver did', async () => {
    const db = createTestDb();
    const [user] = await db.insert(users).values({
      email: 'ada@example.com', name: null, emailVerified: true, createdAt: NOW, updatedAt: NOW,
    }).returning();
    expect(user).toMatchObject({ id: 1, email: 'ada@example.com', name: null, emailVerified: true, role: 'user' });
    await db.insert(accounts).values({ userId: user.id, accountId: '1', providerId: 'credential', createdAt: NOW, updatedAt: NOW });

    // Both tables have an "id" column: array rows keep them apart.
    const joined = await db.select().from(users).innerJoin(accounts, eq(accounts.userId, users.id));
    expect(joined).toEqual([expect.objectContaining({
      users: expect.objectContaining({ id: 1, email: 'ada@example.com' }),
      accounts: expect.objectContaining({ id: 1, userId: 1, providerId: 'credential' }),
    })]);
    expect(await db.query.users.findFirst({ where: eq(users.email, 'ada@example.com') })).toMatchObject({ id: 1, emailVerified: true });
    expect(await db.query.users.findMany()).toHaveLength(1);
    expect(await db.$count(users)).toBe(1);
    expect(await first(db.select({ id: users.id }).from(users).where(eq(users.email, 'nobody@example.com')))).toBeUndefined();

    const updated = await db.update(users).set({ name: 'Ada' }).where(eq(users.id, 1)).returning({ name: users.name });
    expect(updated).toEqual([{ name: 'Ada' }]);
    await db.delete(accounts).where(eq(accounts.userId, 1));
    expect(await db.$count(accounts)).toBe(0);
  });

  it('runs statements outside a transaction at once, many at a time', async () => {
    const db = createTestDb();
    await Promise.all(Array.from({ length: 40 }, (_, i) => put(db, `key-${i}`, String(i))));
    expect(await db.$count(settings)).toBe(40);
  });
});

describe('the gate', () => {
  it('makes queries and transactions from outside wait for the open transaction, in arrival order', async () => {
    const db = createTestDb();
    const events: string[] = [];
    const hold = deferred();
    const a = db.transaction(async (tx) => {
      events.push('A begins');
      await put(tx, 'shared', 'from A');
      await hold.promise;
      events.push('A ends');
    });
    await tick();
    // Queued before B: it runs before B's update, whenever its callback gets to run.
    const read = db.select().from(settings).then((rows) => rows.map((row) => row.value));
    const b = db.transaction(async (tx) => {
      events.push('B begins');
      await tx.update(settings).set({ value: 'from B' }).where(eq(settings.key, 'shared'));
    });
    await tick();
    await tick();
    expect(events).toEqual(['A begins']);

    hold.resolve();
    const [, readValues] = await Promise.all([a, read, b]);
    expect(events).toEqual(['A begins', 'A ends', 'B begins']);
    expect(readValues).toEqual(['from A']);
    expect(await setting(db, 'shared')).toBe('from B');
  });

  it('keeps read-then-write transactions atomic under concurrency', async () => {
    const db = createTestDb();
    await put(db, 'counter', '0');
    await Promise.all(Array.from({ length: 20 }, () => db.transaction(async (tx) => {
      const row = await first(tx.select().from(settings).where(eq(settings.key, 'counter')));
      await tick();
      await tx.update(settings).set({ value: String(Number(row!.value) + 1) }).where(eq(settings.key, 'counter'));
    })));
    expect(await setting(db, 'counter')).toBe('20');
  });

  it('gives each database its own gate and transactions', async () => {
    const a = createTestDb();
    const b = createTestDb();
    await expect(a.transaction(async (tx) => {
      await put(tx, 'in-a', '1');
      // b is neither held back by a's transaction nor part of it.
      await put(b, 'in-b', '1');
      throw new Error('undo a');
    })).rejects.toThrow('undo a');
    expect(await setting(a, 'in-a')).toBeNull();
    expect(await setting(b, 'in-b')).toBe('1');
  });
});

describe('ambient transactions', () => {
  it('runs helpers that use the default db inside the open transaction, and rolls them back with it', async () => {
    const db = createTestDb();
    const helper = (key: string) => put(db, key, 'by helper');

    expect(inTransaction()).toBe(false);
    await expect(db.transaction(async (tx) => {
      expect(inTransaction()).toBe(true);
      await helper('joined');
      // The transaction sees the helper's uncommitted write, and the helper the transaction's.
      expect(await setting(tx, 'joined')).toBe('by helper');
      await put(tx, 'by-tx', '1');
      expect(await setting(db, 'by-tx')).toBe('1');
      expect(await execRaw<{ n: number }>(sql`select count(*) as n from settings`, db)).toEqual([{ n: 2 }]);
      throw new Error('undo');
    })).rejects.toThrow('undo');
    expect(await setting(db, 'joined')).toBeNull();
    expect(await setting(db, 'by-tx')).toBeNull();
    expect(inTransaction()).toBe(false);
  });

  it('commits what the transaction and its helpers wrote', async () => {
    const db = createTestDb();
    const result = await db.transaction(async (tx) => {
      await put(db, 'a', '1');
      await put(tx, 'b', '2');
      return 'done';
    });
    expect(result).toBe('done');
    expect([await setting(db, 'a'), await setting(db, 'b')]).toEqual(['1', '2']);
    expect(db.$client.inTransaction).toBe(false);
  });
});

describe('savepoints', () => {
  it('rolls back only the nested transaction that failed', async () => {
    const db = createTestDb();
    await db.transaction(async (tx) => {
      await put(tx, 'outer', '1');
      await expect(db.transaction(async (inner) => {
        await put(inner, 'failed', '1');
        throw new Error('inner fails');
      })).rejects.toThrow('inner fails');
      await tx.transaction(async (inner) => {
        await put(inner, 'kept', '1');
        await inner.transaction(async (deep) => {
          await put(deep, 'deep', '1');
        });
        await expect(inner.transaction(async (deep) => {
          await put(deep, 'deep-failed', '1');
          deep.rollback();
        })).rejects.toBeInstanceOf(TransactionRollbackError);
      });
      expect(await setting(tx, 'failed')).toBeNull();
    });
    expect({
      outer: await setting(db, 'outer'),
      failed: await setting(db, 'failed'),
      kept: await setting(db, 'kept'),
      deep: await setting(db, 'deep'),
      deepFailed: await setting(db, 'deep-failed'),
    }).toEqual({ outer: '1', failed: null, kept: '1', deep: '1', deepFailed: null });
  });

  it('runs savepoints opened side by side one after the other', async () => {
    const db = createTestDb();
    const order: string[] = [];
    await db.transaction(async () => {
      const results = await Promise.allSettled(['a', 'b', 'c'].map((name) => db.transaction(async (sp) => {
        order.push(`${name} start`);
        await tick();
        await put(sp, name, name);
        order.push(`${name} end`);
        if (name === 'b') throw new Error('b fails');
      })));
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    });
    expect(order).toEqual(['a start', 'a end', 'b start', 'b end', 'c start', 'c end']);
    expect([await setting(db, 'a'), await setting(db, 'b'), await setting(db, 'c')]).toEqual(['a', null, 'c']);
  });
});

describe('rollback', () => {
  it('rolls back and rethrows when the callback throws, and frees the gate', async () => {
    const db = createTestDb();
    await expect(db.transaction(async (tx) => {
      await put(tx, 'gone', '1');
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await setting(db, 'gone')).toBeNull();
    expect(db.$client.inTransaction).toBe(false);
    await put(db, 'after', '1');
    expect(await setting(db, 'after')).toBe('1');
  });

  it('rolls back on tx.rollback() and rethrows TransactionRollbackError', async () => {
    const db = createTestDb();
    await expect(db.transaction(async (tx) => {
      await put(tx, 'gone', '1');
      tx.rollback();
    })).rejects.toBeInstanceOf(TransactionRollbackError);
    expect(await setting(db, 'gone')).toBeNull();
  });

  it('rolls back when a statement fails and the error is not caught', async () => {
    const db = createTestDb();
    await put(db, 'taken', '1');
    await expect(db.transaction(async (tx) => {
      await put(tx, 'first', '1');
      await put(tx, 'taken', '2');
    })).rejects.toThrow();
    expect(await setting(db, 'first')).toBeNull();
    expect(await setting(db, 'taken')).toBe('1');
  });
});

describe('escaped queries', () => {
  it('refuses a query from a promise that outlived its transaction', async () => {
    const db = createTestDb();
    let escaped: Promise<unknown> | undefined;
    await db.transaction(async () => {
      escaped = (async () => {
        await tick();
        return db.select().from(settings);
      })();
    });
    const error = await rejection(escaped!);
    expect(causes(error).some((cause) => cause instanceof TransactionEscapeError)).toBe(true);
  });

  it('refuses a transaction object used after its transaction finished, and a transaction started from one', async () => {
    const db = createTestDb();
    let saved: AppTx | undefined;
    let late: Promise<unknown> | undefined;
    await db.transaction(async (tx) => {
      saved = tx;
      late = (async () => {
        await tick();
        return db.transaction(async () => 'late');
      })();
    });
    const error = await rejection(saved!.select().from(settings));
    expect(causes(error).some((cause) => cause instanceof TransactionEscapeError)).toBe(true);
    expect(await rejection(late!)).toBeInstanceOf(TransactionEscapeError);
  });

  it('runs an escaped query on its own in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const db = createTestDb();
    let escaped: Promise<string | null> | undefined;
    await db.transaction(async (tx) => {
      await put(tx, 'committed', 'yes');
      escaped = (async () => {
        await tick();
        return setting(db, 'committed');
      })();
    });
    expect(await escaped).toBe('yes');
  });

  it('lets deliberate background work run outside the transaction', async () => {
    const db = createTestDb();
    let background: Promise<string | null> | undefined;
    await db.transaction(async (tx) => {
      await put(tx, 'background', 'committed first');
      background = outsideTransaction(async () => {
        expect(inTransaction()).toBe(false);
        await tick();
        return setting(db, 'background');
      });
    });
    expect(await background).toBe('committed first');
  });
});

describe('transaction options', () => {
  it('takes the write lock at BEGIN with behavior "immediate", and at the first write without', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ingressi-db-immediate-'));
    const main = new Database(join(dir, 'app.db'));
    const other = new Database(join(dir, 'app.db'), { timeout: 0 });
    try {
      main.exec('CREATE TABLE notes (body TEXT)');
      const { db } = createSqliteExecutor(main);
      const insertFromOther = (body: string) => other.prepare('INSERT INTO notes (body) VALUES (?)').run(body);

      const holdDeferred = deferred();
      const deferredTx = db.transaction(async () => { await holdDeferred.promise; });
      await tick();
      expect(() => insertFromOther('while deferred')).not.toThrow();
      holdDeferred.resolve();
      await deferredTx;

      const holdImmediate = deferred();
      const immediateTx = db.transaction(async () => { await holdImmediate.promise; }, { behavior: 'immediate' });
      await tick();
      expect(() => insertFromOther('while immediate')).toThrow(/locked|busy/i);
      holdImmediate.resolve();
      await immediateTx;
      expect(() => insertFromOther('after immediate')).not.toThrow();
    } finally {
      main.close();
      other.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses writes in a read-only transaction, which still reads, and leaves later writes alone', async () => {
    const db = createTestDb();
    await put(db, 'mode', 'before');
    await db.transaction(async (tx) => {
      expect(await setting(tx, 'mode')).toBe('before');
      const error = await rejection(tx.update(settings).set({ value: 'inside' }).where(eq(settings.key, 'mode')));
      expect(isReadOnlyError(error)).toBe(true);
      // A helper using the default db is in the same read-only transaction.
      expect(isReadOnlyError(await rejection(put(db, 'helper', '1')))).toBe(true);
    }, { readOnly: true });
    await db.update(settings).set({ value: 'after' }).where(and(eq(settings.key, 'mode')));
    expect(await setting(db, 'mode')).toBe('after');
  });

  it('refuses an unknown BEGIN mode', async () => {
    const db = createTestDb();
    await expect(db.transaction(async () => {}, { behavior: 'sideways' as 'immediate' })).rejects.toThrow(/Unknown transaction behavior/);
    await put(db, 'still', 'works');
  });
});

describe('the watchdog', () => {
  it('logs a transaction that holds the gate too long', async () => {
    const db = createTestDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setTransactionWatchdog(5);
    await db.transaction(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/held the database for \d+ ms \(more than 5 ms\)/));

    warn.mockClear();
    setTransactionWatchdog(null);
    await db.transaction(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('whole-database work', () => {
  it('waits for open transactions and is refused inside one', async () => {
    const db: TestDb = createTestDb();
    const { executor } = resolveDbTarget(db);
    const events: string[] = [];
    const hold = deferred();
    const tx = db.transaction(async () => {
      events.push('transaction');
      await hold.promise;
      await expect(executor.runExclusive(() => 'inside')).rejects.toThrow(/inside a transaction/);
    });
    await tick();
    const exclusive = executor.runExclusive(() => { events.push('exclusive'); return 'ran'; });
    await tick();
    expect(events).toEqual(['transaction']);
    hold.resolve();
    await tx;
    expect(await exclusive).toBe('ran');
    expect(events).toEqual(['transaction', 'exclusive']);
  });
});

describe('the application database', () => {
  it('serves raw SQL and transactions on the application connection', async () => {
    expect(await execRaw<{ one: number }>(sql`select ${1} as one`)).toEqual([{ one: 1 }]);
    const inside = await appDb.transaction(async (tx) => {
      expect(inTransaction()).toBe(true);
      return execRaw<{ two: number }>('select 2 as two', tx);
    });
    expect(inside).toEqual([{ two: 2 }]);
  });
});
