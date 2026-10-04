/**
 * The asynchronous facade on PostgreSQL (src/lib/db/pg-executor.ts) and the
 * cluster lock (src/lib/db/locks.ts), with two pools on the same database
 * standing for two replicas: the write lock serialises writing transactions
 * across them, read-only transactions take no lock and read a snapshot,
 * savepoints roll back alone, escaped queries are refused (and run on their
 * own in production), a transaction a failed statement aborted is not passed
 * off as committed, a connection the server ends fails its transaction
 * without ending the process, and 64-bit integers, booleans and timestamps
 * come back as on SQLite.
 *
 * Runs in the postgres Vitest project (TEST_DB_DIALECT=postgres).
 */
import { eq, sql, TransactionRollbackError } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb, testDbIsPostgres, type TestDb } from '../../helpers/db';
import { createPgReplica } from '../../helpers/pg-test-db';
import { monetizationConsumers, settings, users } from '../../../src/lib/db/schema';
import { execRaw, first, isReadOnlyError, isUniqueViolation, resyncIdentity } from '../../../src/lib/db/ops';
import { inTransaction, TransactionAbortedError, TransactionEscapeError } from '../../../src/lib/db/executor';
import { isClusterLockHeld, withClusterLock } from '../../../src/lib/db/locks';
import type { AppDb, DbExecutor } from '../../../src/lib/db/types';

const NOW = '2026-01-01T00:00:00.000Z';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function put(db: DbExecutor, key: string, value: string) {
  return db.insert(settings).values({ key, value, updatedAt: NOW });
}

async function setting(db: DbExecutor, key: string): Promise<string | null> {
  return (await first(db.select().from(settings).where(eq(settings.key, key))))?.value ?? null;
}

function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let current = error; current instanceof Error && chain.length < 5; current = current.cause) chain.push(current);
  return chain;
}

async function rejection(promise: PromiseLike<unknown>): Promise<unknown> {
  return Promise.resolve(promise).then(() => { throw new Error('expected a rejection'); }, (error: unknown) => error);
}

describe.skipIf(!testDbIsPostgres())('the PostgreSQL executor', () => {
  let db: TestDb;
  let replica: ReturnType<typeof createPgReplica>;
  let other: AppDb;

  beforeAll(async () => {
    db = createTestDb();
    await db.$count(settings); // waits for the database to be emptied
    replica = createPgReplica();
    other = replica.db;
  });

  afterAll(async () => {
    await replica?.close();
  });

  describe('writing transactions', () => {
    it('are serialised across replicas by the write lock', async () => {
      const events: string[] = [];
      const hold = deferred();
      const a = db.transaction(async (tx) => {
        events.push('A begins');
        await put(tx, 'serial', 'from A');
        await hold.promise;
        events.push('A ends');
      });
      await sleep(50);
      const b = other.transaction(async (tx) => {
        events.push('B begins');
        // B starts after A committed, so it sees A's row.
        await tx.update(settings).set({ value: `${await setting(tx, 'serial')} then B` }).where(eq(settings.key, 'serial'));
      });
      await sleep(150);
      expect(events).toEqual(['A begins']);
      hold.resolve();
      await Promise.all([a, b]);
      expect(events).toEqual(['A begins', 'A ends', 'B begins']);
      expect(await setting(db, 'serial')).toBe('from A then B');
    });

    it('keep read-then-write atomic when both replicas write at once', async () => {
      await put(db, 'counter', '0');
      const increment = (on: AppDb) => on.transaction(async (tx) => {
        const row = await first(tx.select().from(settings).where(eq(settings.key, 'counter')));
        await sleep(2);
        await tx.update(settings).set({ value: String(Number(row!.value) + 1) }).where(eq(settings.key, 'counter'));
      });
      await Promise.all(Array.from({ length: 16 }, (_, i) => increment(i % 2 === 0 ? db : other)));
      expect(await setting(db, 'counter')).toBe('16');
    });

    it('run helpers that use the default db inside the open transaction, and roll them back with it', async () => {
      await expect(db.transaction(async (tx) => {
        expect(inTransaction()).toBe(true);
        await put(db, 'joined', 'by helper');
        expect(await setting(tx, 'joined')).toBe('by helper');
        // Another replica does not see uncommitted rows.
        expect(await setting(other, 'joined')).toBeNull();
        expect(await execRaw<{ n: number }>(sql`select count(*) as n from settings where key = 'joined'`, db)).toEqual([{ n: 1 }]);
        throw new Error('undo');
      })).rejects.toThrow('undo');
      expect(await setting(db, 'joined')).toBeNull();
    });

    it('report a transaction a caught failed statement aborted instead of committing it', async () => {
      await put(db, 'taken', '1');
      const error = await rejection(db.transaction(async (tx) => {
        await put(tx, 'lost', '1');
        const failed = await rejection(put(tx, 'taken', '2'));
        expect(isUniqueViolation(failed)).toBe(true);
      }));
      expect(error).toBeInstanceOf(TransactionAbortedError);
      expect(await setting(db, 'lost')).toBeNull();

      // A statement that may fail runs in a savepoint: the transaction carries on.
      await db.transaction(async (tx) => {
        await put(tx, 'kept', '1');
        const failed = await rejection(tx.transaction(async (sp) => { await put(sp, 'taken', '3'); }));
        expect(isUniqueViolation(failed)).toBe(true);
        await put(tx, 'after', '1');
      });
      expect([await setting(db, 'kept'), await setting(db, 'after'), await setting(db, 'taken')]).toEqual(['1', '1', '1']);
    });
  });

  describe('read-only transactions', () => {
    it('take no lock, read a snapshot and refuse writes', async () => {
      await put(db, 'snapshot', 'before');
      const hold = deferred();
      const writing = db.transaction(async (tx) => {
        await tx.update(settings).set({ value: 'uncommitted' }).where(eq(settings.key, 'snapshot'));
        await hold.promise;
      });
      await sleep(50);
      const seen: Array<string | null> = [];
      // Completes while the writing transaction holds the write lock.
      await other.transaction(async (tx) => {
        seen.push(await setting(tx, 'snapshot'));
        const refused = await rejection(tx.insert(settings).values({ key: 'ro', value: 'x', updatedAt: NOW }));
        expect(isReadOnlyError(refused)).toBe(true);
      }, { readOnly: true });
      expect(seen).toEqual(['before']);

      // The snapshot holds for the whole transaction: a commit in between is not seen.
      await other.transaction(async (tx) => {
        seen.push(await setting(tx, 'snapshot'));
        hold.resolve();
        await writing;
        seen.push(await setting(tx, 'snapshot'));
      }, { readOnly: true });
      expect(seen).toEqual(['before', 'before', 'before']);
      expect(await setting(other, 'snapshot')).toBe('uncommitted');
    });
  });

  describe('savepoints', () => {
    it('roll back only the nested transaction that failed', async () => {
      await db.transaction(async (tx) => {
        await put(tx, 'outer', '1');
        await expect(db.transaction(async (inner) => {
          await put(inner, 'failed', '1');
          throw new Error('inner fails');
        })).rejects.toThrow('inner fails');
        await tx.transaction(async (inner) => {
          await put(inner, 'nested', '1');
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
        nested: await setting(db, 'nested'),
        deepFailed: await setting(db, 'deep-failed'),
      }).toEqual({ outer: '1', failed: null, nested: '1', deepFailed: null });
    });

    it('run one after the other when opened side by side', async () => {
      const order: string[] = [];
      await db.transaction(async () => {
        const results = await Promise.allSettled(['sa', 'sb', 'sc'].map((name) => db.transaction(async (sp) => {
          order.push(`${name} start`);
          await sleep(1);
          await put(sp, name, name);
          order.push(`${name} end`);
          if (name === 'sb') throw new Error('sb fails');
        })));
        expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
      });
      expect(order).toEqual(['sa start', 'sa end', 'sb start', 'sb end', 'sc start', 'sc end']);
      expect([await setting(db, 'sa'), await setting(db, 'sb'), await setting(db, 'sc')]).toEqual(['sa', null, 'sc']);
    });
  });

  describe('lost connections', () => {
    it('fail the transaction without ending the process, and let the next writer in', async () => {
      const hold = deferred();
      let pid = 0;
      const doomed = db.transaction(async (tx) => {
        pid = (await execRaw<{ pid: number }>('select pg_backend_pid() as pid', tx))[0].pid;
        await hold.promise;
        await put(tx, 'after-kill', '1');
      });
      await sleep(50);
      await replica.pool.query('select pg_terminate_backend($1)', [pid]);
      await sleep(50);
      hold.resolve();
      await expect(doomed).rejects.toThrow();
      // The write lock and the writer queue were released.
      await db.transaction(async (tx) => { await put(tx, 'next-writer', '1'); });
      expect([await setting(db, 'after-kill'), await setting(db, 'next-writer')]).toEqual([null, '1']);
    });
  });

  describe('escaped queries', () => {
    it('run on their own in production', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      try {
        let escaped: Promise<string | null> | undefined;
        await db.transaction(async (tx) => {
          await put(tx, 'escaped-in-production', 'committed');
          escaped = (async () => {
            await sleep(30);
            return setting(db, 'escaped-in-production');
          })();
        });
        expect(await escaped).toBe('committed');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('are refused after their transaction finished', async () => {
      let escaped: Promise<unknown> | undefined;
      let saved: unknown;
      await db.transaction(async (tx) => {
        saved = tx;
        escaped = (async () => {
          await sleep(5);
          return db.select().from(settings);
        })();
      });
      expect(causes(await rejection(escaped!)).some((cause) => cause instanceof TransactionEscapeError)).toBe(true);
      const late = await rejection((saved as AppDb).select().from(settings));
      expect(causes(late).some((cause) => cause instanceof TransactionEscapeError)).toBe(true);
    });
  });

  describe('values', () => {
    it('come back as on SQLite: 64-bit integers as numbers, booleans, timestamps as ISO text', async () => {
      const big = 5_000_000_000_123;
      const [consumer] = await db.insert(monetizationConsumers).values({
        name: 'Example consumer', balanceMicros: big, overdraftAllowanceMicros: -big, createdAt: NOW, updatedAt: NOW,
      }).returning();
      expect(consumer.balanceMicros).toBe(big);
      const [read] = await db.select({
        balance: monetizationConsumers.balanceMicros,
        total: sql<number>`sum(${monetizationConsumers.balanceMicros})`,
        count: sql<number>`count(*)`,
      }).from(monetizationConsumers).groupBy(monetizationConsumers.balanceMicros);
      expect(read).toEqual({ balance: big, total: big, count: 1 });
      expect(await db.$count(monetizationConsumers)).toBe(1);

      const [user] = await db.insert(users).values({
        email: 'flags@example.com', emailVerified: true, createdAt: NOW, updatedAt: NOW,
      }).returning();
      expect(user.emailVerified).toBe(true);
      expect(user.twoFactorEnabled).toBe(false);
      expect(await first(db.select({ id: users.id }).from(users).where(eq(users.emailVerified, true)))).toEqual({ id: user.id });

      expect(await execRaw(sql`select ${'9007199254740991'}::bigint as big, 2.5::numeric as half, true as yes, false as no,
        '2026-01-02 03:04:05.678+02'::timestamptz as at, '2026-01-02 03:04:05'::timestamp as local`, db)).toEqual([{
        big: 9007199254740991, half: 2.5, yes: true, no: false, at: '2026-01-02T01:04:05.678Z', local: '2026-01-02T03:04:05.000Z',
      }]);
      const [{ now }] = await execRaw<{ now: string }>('select now() as now', db);
      expect(now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('continue identity columns after explicit ids once resynced', async () => {
      await db.insert(users).values({ id: 500, email: 'explicit@example.com', createdAt: NOW, updatedAt: NOW });
      await resyncIdentity(users, db);
      const [next] = await db.insert(users).values({ email: 'next@example.com', createdAt: NOW, updatedAt: NOW }).returning();
      expect(next.id).toBe(501);
      // A table whose key is not an identity column is left alone.
      await expect(resyncIdentity(settings, db)).resolves.toBeUndefined();
    });

    it('never move an identity back, so ids are not handed out again (as SQLite AUTOINCREMENT)', async () => {
      const [last] = await db.insert(users).values({ email: 'last@example.com', createdAt: NOW, updatedAt: NOW }).returning();
      // A configuration restore: the newest rows are gone, older ones written back with their ids.
      await db.delete(users).where(eq(users.id, last.id));
      await resyncIdentity(users, db);
      const [next] = await db.insert(users).values({ email: 'after-restore@example.com', createdAt: NOW, updatedAt: NOW }).returning();
      expect(next.id).toBe(last.id + 1);
    });
  });

  describe('cluster locks', () => {
    it('wait for the same lock held from another connection, and release it', async () => {
      const elsewhere = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await elsewhere.connect();
      try {
        await elsewhere.query("SELECT pg_advisory_lock(hashtext('pg-cluster-job'))");
        const events: string[] = [];
        const holder = withClusterLock('pg-cluster-job', async () => { events.push('ran'); return 'done'; }, { pool: replica.pool });
        await sleep(100);
        expect(events).toEqual([]);
        expect(isClusterLockHeld('pg-cluster-job')).toBe(true);
        await elsewhere.query("SELECT pg_advisory_unlock(hashtext('pg-cluster-job'))");
        expect(await holder).toBe('done');
        expect(events).toEqual(['ran']);
        // Released on the server: the other connection takes it at once.
        const { rows } = await elsewhere.query<{ got: boolean }>("SELECT pg_try_advisory_lock(hashtext('pg-cluster-job')) AS got");
        expect(rows[0].got).toBe(true);
        await elsewhere.query("SELECT pg_advisory_unlock(hashtext('pg-cluster-job'))");
      } finally {
        await elsewhere.end();
      }
    });

    it('release the advisory lock when the work fails', async () => {
      await expect(withClusterLock('pg-failing-job', async () => { throw new Error('nope'); }, { pool: replica.pool })).rejects.toThrow('nope');
      expect(isClusterLockHeld('pg-failing-job')).toBe(false);
      const elsewhere = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await elsewhere.connect();
      try {
        const { rows } = await elsewhere.query<{ got: boolean }>("SELECT pg_try_advisory_lock(hashtext('pg-failing-job')) AS got");
        expect(rows[0].got).toBe(true);
      } finally {
        await elsewhere.end();
      }
    });
  });
});
