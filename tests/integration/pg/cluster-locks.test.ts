/**
 * Cluster locks (src/lib/db/locks.ts) between two replicas: two pools on
 * the same PostgreSQL database, each its own lock scope, so only the
 * advisory lock stands between them, as between two processes. Mutual
 * exclusion, the try form skipping, release when the work fails, release
 * when the holder's connection dies (and the holder being told), the lock
 * session's keepalives, and coalescing per replica.
 *
 * Runs in the postgres Vitest project (TEST_DB_DIALECT=postgres).
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb, testDbIsPostgres } from '../../helpers/db';
import { createPgReplica } from '../../helpers/pg-test-db';
import { settings } from '../../../src/lib/db/schema';
import {
  ClusterLockLostError,
  isClusterLockHeld,
  tryWithClusterLock,
  withClusterLock,
  withCoalescedClusterLock,
  type ClusterLockPool,
} from '../../../src/lib/db/locks';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Sessions holding (granted) or waiting for the advisory lock of `name`, as the server sees them. */
async function advisorySessions(client: pg.Client, name: string): Promise<Array<{ pid: number; granted: boolean }>> {
  const { rows } = await client.query<{ pid: number; granted: boolean }>(
    `SELECT l.pid, l.granted FROM pg_locks l, (SELECT hashtext($1)::bigint AS k) key
      WHERE l.locktype = 'advisory' AND l.objsubid = 1 AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND l.classid = ((key.k >> 32) & 4294967295)::oid AND l.objid = (key.k & 4294967295)::oid
      ORDER BY l.granted DESC, l.pid`,
    [name]
  );
  return rows;
}

describe.skipIf(!testDbIsPostgres())('cluster locks between two replicas', () => {
  let a: ReturnType<typeof createPgReplica>;
  let b: ReturnType<typeof createPgReplica>;
  let observer: pg.Client;

  beforeAll(async () => {
    const db = createTestDb();
    await db.$count(settings); // waits for the database to be emptied
    a = createPgReplica();
    b = createPgReplica();
    observer = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await observer.connect();
  });

  afterAll(async () => {
    await observer?.end();
    await a?.close();
    await b?.close();
  });

  it('exclude each other: the second replica waits on the server until the first releases', async () => {
    const events: string[] = [];
    const release = deferred();
    const first = withClusterLock('pg-replicas-exclusive', async () => {
      events.push('a start');
      await release.promise;
      events.push('a end');
      return 'a';
    }, { pool: a.pool });
    await vi.waitFor(async () => expect(await advisorySessions(observer, 'pg-replicas-exclusive')).toHaveLength(1));

    const second = withClusterLock('pg-replicas-exclusive', () => { events.push('b'); return 'b'; }, { pool: b.pool });
    // B's session waits for the lock on the server: one granted, one waiting.
    await vi.waitFor(async () =>
      expect((await advisorySessions(observer, 'pg-replicas-exclusive')).map((session) => session.granted)).toEqual([true, false]));
    await sleep(50);
    expect(events).toEqual(['a start']);

    release.resolve();
    expect(await Promise.all([first, second])).toEqual(['a', 'b']);
    expect(events).toEqual(['a start', 'a end', 'b']);
    expect(await advisorySessions(observer, 'pg-replicas-exclusive')).toEqual([]);
  });

  it('skip with the try form while another replica holds the lock, and take it once it is free', async () => {
    const release = deferred();
    const holder = withClusterLock('pg-replicas-try', () => release.promise, { pool: a.pool });
    await vi.waitFor(async () => expect(await advisorySessions(observer, 'pg-replicas-try')).toHaveLength(1));

    let ran = false;
    expect(await tryWithClusterLock('pg-replicas-try', () => { ran = true; }, { pool: b.pool })).toEqual({ acquired: false });
    expect(ran).toBe(false);
    // The skipped try left nothing behind: no waiting session, B's connection back in its pool.
    expect(await advisorySessions(observer, 'pg-replicas-try')).toHaveLength(1);
    expect(b.pool.totalCount - b.pool.idleCount).toBe(0);

    release.resolve();
    await holder;
    expect(await tryWithClusterLock('pg-replicas-try', () => 'b ran', { pool: b.pool })).toEqual({ acquired: true, value: 'b ran' });
  });

  it('are released when the work fails', async () => {
    await expect(withClusterLock('pg-replicas-failing', () => { throw new Error('nope'); }, { pool: a.pool })).rejects.toThrow('nope');
    await expect(tryWithClusterLock('pg-replicas-failing', () => { throw new Error('again'); }, { pool: a.pool })).rejects.toThrow('again');
    expect(await advisorySessions(observer, 'pg-replicas-failing')).toEqual([]);
    expect(await tryWithClusterLock('pg-replicas-failing', () => 'b took it', { pool: b.pool })).toEqual({ acquired: true, value: 'b took it' });
  });

  it('are released when the holder\'s connection dies, and the holder is told', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const release = deferred();
      const lost = deferred<unknown>();
      const holder = withClusterLock('pg-replicas-lost', async (lock) => {
        lock.signal.addEventListener('abort', () => lost.resolve(lock.signal.reason));
        await release.promise;
        return lock.signal.aborted;
      }, { pool: a.pool });
      await vi.waitFor(async () => expect(await advisorySessions(observer, 'pg-replicas-lost')).toHaveLength(1));
      const waiter = withClusterLock('pg-replicas-lost', () => 'b got it', { pool: b.pool });
      await vi.waitFor(async () => expect(await advisorySessions(observer, 'pg-replicas-lost')).toHaveLength(2));

      // The server ends A's session (a crash, a restart, a network failure it noticed).
      const [held] = await advisorySessions(observer, 'pg-replicas-lost');
      expect(held.granted).toBe(true);
      await observer.query('SELECT pg_terminate_backend($1)', [held.pid]);

      // B takes the lock while A's work still runs, and A learns it lost the lock.
      expect(await waiter).toBe('b got it');
      expect(await lost.promise).toBeInstanceOf(ClusterLockLostError);
      release.resolve();
      expect(await holder).toBe(true);
      expect(isClusterLockHeld('pg-replicas-lost')).toBe(false);
      // A's pool dropped the dead connection and works on.
      expect(await tryWithClusterLock('pg-replicas-lost', () => 'a again', { pool: a.pool })).toEqual({ acquired: true, value: 'a again' });
    } finally {
      errors.mockRestore();
    }
  });

  it('turn TCP keepalives on for the lock\'s session and reset it before the connection is reused', async () => {
    let lockConnection: pg.PoolClient | null = null;
    const recording: ClusterLockPool = {
      connect: async () => {
        lockConnection = await a.pool.connect();
        return lockConnection;
      },
    } as ClusterLockPool;
    const keepalive = async () => (await lockConnection!.query<{ tcp_keepalives_idle: string }>('SHOW tcp_keepalives_idle')).rows[0].tcp_keepalives_idle;
    const statementTimeout = async () => (await lockConnection!.query<{ statement_timeout: string }>('SHOW statement_timeout')).rows[0].statement_timeout;
    const during = await withClusterLock('pg-replicas-session', async () => ({ keepalive: await keepalive(), timeout: await statementTimeout() }), { pool: recording });
    expect(during).toEqual({ keepalive: '10', timeout: '0' });
    // Back in the pool (not closed) with the pool's settings.
    expect(a.pool.idleCount).toBeGreaterThan(0);
    expect(await keepalive()).not.toBe('10');
    expect(await statementTimeout()).toBe('1min');
  });

  it('coalesce calls per replica: a burst on one replica runs twice, waiting for the other replica first', async () => {
    const release = deferred();
    const holder = withClusterLock('pg-replicas-coalesce', () => release.promise, { pool: b.pool });
    await vi.waitFor(async () => expect(await advisorySessions(observer, 'pg-replicas-coalesce')).toHaveLength(1));
    let runs = 0;
    const work = async () => ++runs;
    const calls = [1, 2, 3].map(() => withCoalescedClusterLock('pg-replicas-coalesce', work, { pool: a.pool }));
    await sleep(50);
    expect(runs).toBe(0);
    release.resolve();
    await holder;
    expect(await Promise.all(calls)).toEqual([1, 1, 1]);
    expect(runs).toBe(1);
  });
});
