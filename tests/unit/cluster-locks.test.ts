/**
 * The cluster lock's try and coalescing forms (src/lib/db/locks.ts) in one
 * process: tryWithClusterLock never waits and skips while the lock is held
 * or waited for; withCoalescedClusterLock lets a call join a run still
 * waiting for the lock, so a burst runs the work at most twice. Both are
 * re-entrant and refused inside a transaction, like withClusterLock. Runs on
 * the test database's dialect (on PostgreSQL the advisory lock is taken
 * too); tests/integration/pg/cluster-locks.test.ts covers two replicas.
 */
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db';
import {
  holdsClusterLock,
  isClusterLockHeld,
  tryWithClusterLock,
  withClusterLock,
  withCoalescedClusterLock,
} from '../../src/lib/db/locks';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function failure(promise: PromiseLike<unknown>): Promise<unknown> {
  return Promise.resolve(promise).then(() => { throw new Error('expected a rejection'); }, (error: unknown) => error);
}

describe('tryWithClusterLock', () => {
  it('runs the work when the lock is free and skips it, without waiting, while it is held', async () => {
    expect(await tryWithClusterLock('try-free', (lock) => ({ aborted: lock.signal.aborted }))).toEqual({ acquired: true, value: { aborted: false } });

    const release = deferred();
    const holder = withClusterLock('try-held', async () => { await release.promise; return 'held'; });
    await sleep(20);
    let ran = false;
    expect(await tryWithClusterLock('try-held', () => { ran = true; })).toEqual({ acquired: false });
    expect(ran).toBe(false);

    // A waiter counts as well: the try does not queue behind it.
    const waiter = withClusterLock('try-held', () => 'waited');
    expect(await tryWithClusterLock('try-held', () => { ran = true; })).toEqual({ acquired: false });
    release.resolve();
    expect(await holder).toBe('held');
    expect(await waiter).toBe('waited');
    expect(ran).toBe(false);
    expect(isClusterLockHeld('try-held')).toBe(false);
    expect(await tryWithClusterLock('try-held', () => 'free again')).toEqual({ acquired: true, value: 'free again' });
  });

  it('is re-entrant, releases the lock when the work fails, and is refused inside a transaction', async () => {
    const nested = await withClusterLock('try-nested', async () => {
      expect(holdsClusterLock('try-nested')).toBe(true);
      return await tryWithClusterLock('try-nested', () => 'inside');
    });
    expect(nested).toEqual({ acquired: true, value: 'inside' });
    expect(holdsClusterLock('try-nested')).toBe(false);

    expect(await failure(tryWithClusterLock('try-failing', () => { throw new Error('nope'); }))).toMatchObject({ message: 'nope' });
    expect(isClusterLockHeld('try-failing')).toBe(false);
    expect(await tryWithClusterLock('try-failing', () => 'free')).toEqual({ acquired: true, value: 'free' });

    const db = createTestDb();
    await db.transaction(async () => {
      await expect(tryWithClusterLock('try-inside', () => 'x')).rejects.toThrow(/inside a database transaction/);
    });
    await expect(tryWithClusterLock('', () => 'x')).rejects.toThrow(/lock name/);
  });
});

describe('withCoalescedClusterLock', () => {
  it('lets calls made while a run waits for the lock share that run', async () => {
    const release = deferred();
    let runs = 0;
    const work = async () => {
      runs += 1;
      const run = runs;
      if (run === 1) await release.promise;
      return run;
    };
    const first = withCoalescedClusterLock('coalesce', work);
    await sleep(20);
    // The first run holds the lock: the next call queues a run, the others join it.
    const second = withCoalescedClusterLock('coalesce', work);
    const third = withCoalescedClusterLock('coalesce', work);
    const fourth = withCoalescedClusterLock('coalesce', work);
    await sleep(20);
    expect(runs).toBe(1);
    release.resolve();
    expect(await Promise.all([first, second, third, fourth])).toEqual([1, 2, 2, 2]);
    expect(runs).toBe(2);

    // A call after a run started gets a run of its own.
    expect(await withCoalescedClusterLock('coalesce', work)).toBe(3);
    expect(isClusterLockHeld('coalesce')).toBe(false);
  });

  it('gives every joined caller the error of the run, and starts a new run after it', async () => {
    const release = deferred();
    let runs = 0;
    const holder = withClusterLock('coalesce-failing', async () => { await release.promise; });
    await sleep(20);
    const work = async () => {
      runs += 1;
      throw new Error(`run ${runs} failed`);
    };
    const a = failure(withCoalescedClusterLock('coalesce-failing', work));
    const b = failure(withCoalescedClusterLock('coalesce-failing', work));
    release.resolve();
    await holder;
    expect(await a).toMatchObject({ message: 'run 1 failed' });
    expect(await b).toMatchObject({ message: 'run 1 failed' });
    expect(runs).toBe(1);
    expect(await withCoalescedClusterLock('coalesce-failing', () => 'recovered')).toBe('recovered');
  });

  it('runs at once inside the lock and is refused inside a transaction', async () => {
    const order: string[] = [];
    await withCoalescedClusterLock('coalesce-nested', async () => {
      order.push('outer');
      await withCoalescedClusterLock('coalesce-nested', async () => { order.push('inner'); });
      order.push('outer end');
    });
    expect(order).toEqual(['outer', 'inner', 'outer end']);

    const db = createTestDb();
    await db.transaction(async () => {
      await expect(withCoalescedClusterLock('coalesce-inside', () => 'x')).rejects.toThrow(/inside a database transaction/);
    });
  });
});
