/**
 * Named locks that hold across the whole deployment (src/lib/db/README.md):
 * use them instead of in-process locks for work that must not overlap
 * anywhere (applying the Caddy configuration, a settings update, a backup to
 * one destination).
 *
 * - withClusterLock(name, fn): waits for the lock, first in, first out.
 * - tryWithClusterLock(name, fn): runs fn only when the lock is free right
 *   now, and otherwise reports that it was not acquired (a periodic job
 *   skips that round).
 * - withCoalescedClusterLock(name, fn): for work that brings something up to
 *   date with the database (pushing the configuration to Caddy): a call that
 *   finds another call of this process still waiting for the lock joins it.
 *
 * On SQLite there is one application process per database, so the lock is
 * an in-process first-in, first-out lock per name. On PostgreSQL the holder
 * also takes the session advisory lock pg_advisory_lock(hashtext(name)) on a
 * connection of its own, so the lock holds between replicas; the in-process
 * lock in front of it keeps waiters of one process from taking a connection
 * each. Those connections come from a small pool of their own, so work that
 * holds locks for long never leaves queries (request paths among them)
 * without a connection. The advisory lock is released (pg_advisory_unlock)
 * when the work ends, and by the server when the connection is lost: the
 * process crashed, the server restarted, or the network failed (the lock's
 * session turns TCP keepalives on, so the server notices a client that
 * stopped answering within about half a minute rather than hours). When the
 * holder's connection fails while its work still runs, another replica may
 * take the lock: the work is told through its signal (ClusterLockContext).
 *
 * Take the lock outside transactions, never inside one: a transaction holds
 * the database gate, and the lock holder may be waiting for that gate.
 * Re-entrant: the same async context taking a lock it holds runs at once.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type pg from "pg";
import { isPostgres } from "./dialect";
import { inTransaction } from "./executor";
import { createPostgresPool, readPostgresConfig, watchHeldConnection } from "./postgres";

type Waiter = () => void;

/** One holding of a lock; inactive once released, so work that outlives it is not re-entrant. */
interface LockHold {
  active: boolean;
  signal: AbortSignal;
}

interface NamedLock {
  locked: boolean;
  waiters: Waiter[];
}

/** A withCoalescedClusterLock call; `started` once its work runs (later calls no longer join it). */
interface CoalescedRun {
  promise: Promise<unknown>;
  started: boolean;
}

/** What the work under a cluster lock is given. */
export interface ClusterLockContext {
  /**
   * Aborted (with a ClusterLockLostError) when the lock may no longer be
   * held: on PostgreSQL, the connection holding the advisory lock failed and
   * the server released the lock with it. Never aborted on SQLite. Work that
   * pushes state somewhere checks it before pushing, and does the work again
   * under the lock when the lock was lost.
   */
  signal: AbortSignal;
}

/** Why a ClusterLockContext signal was aborted. */
export class ClusterLockLostError extends Error {
  readonly lockName: string;

  constructor(lockName: string) {
    super(`The cluster lock "${lockName}" was lost: its database connection failed`);
    this.name = "ClusterLockLostError";
    this.lockName = lockName;
  }
}

/** What a cluster lock needs of a pool on PostgreSQL (tests pass their own). */
export type ClusterLockPool = Pick<pg.Pool, "connect">;

export type ClusterLockOptions = {
  /**
   * PostgreSQL: the pool to take the advisory lock on (default: the lock
   * pool). The in-process lock is kept per pool, so in a test two pools
   * stand for two processes (two replicas).
   */
  pool?: ClusterLockPool;
};

/** tryWithClusterLock's outcome: the work's value, or that someone else holds the lock. */
export type TryLockResult<T> = { acquired: true; value: T } | { acquired: false };

type GlobalLockState = typeof globalThis & {
  __ingressiClusterLocks?: Map<string, NamedLock>;
  __ingressiClusterLockContext?: AsyncLocalStorage<ReadonlyMap<string, LockHold>>;
  __ingressiClusterLockRuns?: Map<string, CoalescedRun>;
  __ingressiClusterLockPool?: pg.Pool;
};

const globalState = globalThis as GlobalLockState;
/** The in-process locks, by lockKey (scope and name). */
const locks = (globalState.__ingressiClusterLocks ??= new Map<string, NamedLock>());
/** The locks the current async context holds, by lockKey. */
const heldLocks = (globalState.__ingressiClusterLockContext ??= new AsyncLocalStorage<ReadonlyMap<string, LockHold>>());
/** The withCoalescedClusterLock calls waiting for their lock, by lockKey. */
const coalescedRuns = (globalState.__ingressiClusterLockRuns ??= new Map<string, CoalescedRun>());

// ── Scopes: one per pool, so a test can hold two replicas in one process ──

const DEFAULT_SCOPE = 0;
const scopeIds = new WeakMap<object, number>();
let nextScopeId = DEFAULT_SCOPE + 1;

function lockKey(name: string, options: ClusterLockOptions): string {
  let scope = DEFAULT_SCOPE;
  if (options.pool) {
    scope = scopeIds.get(options.pool) ?? nextScopeId++;
    scopeIds.set(options.pool, scope);
  }
  return `${scope}\u0000${name}`;
}

// ── The in-process lock ──

function namedLock(key: string): NamedLock {
  let lock = locks.get(key);
  if (!lock) {
    lock = { locked: false, waiters: [] };
    locks.set(key, lock);
  }
  return lock;
}

function acquire(key: string): Promise<void> {
  const lock = namedLock(key);
  if (!lock.locked) {
    lock.locked = true;
    return Promise.resolve();
  }
  return new Promise((resolve) => lock.waiters.push(resolve));
}

/** Takes the in-process lock unless somebody holds it. */
function tryAcquire(key: string): boolean {
  const lock = namedLock(key);
  if (lock.locked) return false;
  lock.locked = true;
  return true;
}

function release(key: string): void {
  const lock = locks.get(key);
  if (!lock) return;
  const next = lock.waiters.shift();
  if (next) {
    next();
    return;
  }
  lock.locked = false;
  locks.delete(key);
}

/** Whether `name` is held or waited for by anyone in this process (tests and diagnostics). */
export function isClusterLockHeld(name: string): boolean {
  const suffix = `\u0000${name}`;
  for (const [key, lock] of locks) {
    if (lock.locked && key.endsWith(suffix)) return true;
  }
  return false;
}

/** Whether the calling async context holds `name` (taking it again runs at once). */
export function holdsClusterLock(name: string, options: ClusterLockOptions = {}): boolean {
  return heldLocks.getStore()?.get(lockKey(name, options))?.active ?? false;
}

function checkName(what: string, name: string): void {
  if (typeof name !== "string" || name.trim() === "") throw new Error(`${what} needs a lock name`);
}

function refuseInsideTransaction(what: string, name: string): void {
  if (!inTransaction()) return;
  const message = `${what}("${name}") was called inside a database transaction; take the lock before the transaction`;
  if (process.env.NODE_ENV !== "production") throw new Error(message);
  console.warn(`[db] ${message}`);
}

// ── PostgreSQL: the advisory lock ──

/** Connections the lock pool opens at most: one per lock this process holds or waits for. */
export const LOCK_POOL_MAX = 20;

/** The pool advisory locks are taken on: the application's connection settings, a pool of its own. */
function getLockPool(): pg.Pool {
  return (globalState.__ingressiClusterLockPool ??= createPostgresPool({ ...readPostgresConfig(), max: LOCK_POOL_MAX }));
}

/**
 * The session of a connection holding a lock: no statement or lock timeout
 * (waiting for the lock has no time limit, as the in-process lock has none),
 * and TCP keepalives, so that the server ends the session, releasing the
 * lock, about 25 seconds after the client stopped answering. (Ignored on a
 * Unix socket, where the server learns of a lost client at once.)
 */
const LOCK_SESSION =
  "SET statement_timeout = 0; SET lock_timeout = 0; " +
  "SET tcp_keepalives_idle = 10; SET tcp_keepalives_interval = 5; SET tcp_keepalives_count = 3";
/** The pool's settings again, before the connection goes back to it. */
const POOL_SESSION =
  "RESET statement_timeout; RESET lock_timeout; " +
  "RESET tcp_keepalives_idle; RESET tcp_keepalives_interval; RESET tcp_keepalives_count";

interface AdvisoryLock {
  signal: AbortSignal;
  release(): Promise<void>;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Takes pg_advisory_lock(hashtext(name)) on a connection of its own (with
 * `wait` false, pg_try_advisory_lock: null when another session holds it)
 * and returns how to release it, with the signal aborted when the
 * connection, and with it the lock, is lost.
 */
async function takeAdvisoryLock(name: string, pool: ClusterLockPool, wait: boolean): Promise<AdvisoryLock | null> {
  const connection = await pool.connect();
  const unwatch = watchHeldConnection(connection, `the cluster lock "${name}"`);
  const lost = new AbortController();
  // Once the lock is held: the connection failing or ending means the server released it.
  const onLost = () => {
    if (lost.signal.aborted) return;
    console.error(`[db] The connection holding the cluster lock "${name}" was lost, and the lock with it`);
    lost.abort(new ClusterLockLostError(name));
  };
  const stopWatching = () => {
    connection.removeListener("error", onLost);
    connection.removeListener("end", onLost);
    unwatch();
  };
  try {
    if (wait) {
      await connection.query(LOCK_SESSION);
      await connection.query("SELECT pg_advisory_lock(hashtext($1))", [name]);
      connection.on("error", onLost);
      connection.on("end", onLost);
    } else {
      const { rows } = await connection.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [name]);
      if (rows[0]?.locked !== true) {
        stopWatching();
        connection.release();
        return null;
      }
      connection.on("error", onLost);
      connection.on("end", onLost);
      await connection.query(LOCK_SESSION);
    }
  } catch (error) {
    // A connection whose session state is unknown is closed, not reused
    // (which also releases a lock it may hold).
    stopWatching();
    connection.release(asError(error));
    throw error;
  }
  return {
    signal: lost.signal,
    release: async () => {
      let broken: Error | undefined;
      try {
        await connection.query("SELECT pg_advisory_unlock(hashtext($1))", [name]);
        await connection.query(POOL_SESSION);
      } catch (error) {
        // Closing the connection releases the lock on the server.
        broken = asError(error);
        if (!lost.signal.aborted) {
          console.error(`[db] Could not release the cluster lock "${name}" cleanly; closing its connection:`, broken.message);
        }
      } finally {
        stopWatching();
        connection.release(broken);
      }
    },
  };
}

// ── Holding ──

const NEVER_ABORTED = new AbortController().signal;

async function runHolding<T>(
  key: string,
  held: ReadonlyMap<string, LockHold> | undefined,
  hold: LockHold,
  fn: (lock: ClusterLockContext) => T | Promise<T>
): Promise<T> {
  const holds = new Map(held ?? []);
  holds.set(key, hold);
  return await heldLocks.run(holds, () => fn({ signal: hold.signal }));
}

/**
 * Runs `fn` while holding the lock `name`, after whoever holds or waits for
 * it, and returns its result.
 */
export async function withClusterLock<T>(
  name: string,
  fn: (lock: ClusterLockContext) => T | Promise<T>,
  options: ClusterLockOptions = {}
): Promise<T> {
  checkName("withClusterLock", name);
  const key = lockKey(name, options);
  const held = heldLocks.getStore();
  const outer = held?.get(key);
  if (outer?.active) return await fn({ signal: outer.signal });
  refuseInsideTransaction("withClusterLock", name);

  await acquire(key);
  let advisory: AdvisoryLock | null = null;
  let hold: LockHold | null = null;
  try {
    if (isPostgres()) advisory = await takeAdvisoryLock(name, options.pool ?? getLockPool(), true);
    hold = { active: true, signal: advisory?.signal ?? NEVER_ABORTED };
    return await runHolding(key, held, hold, fn);
  } finally {
    if (hold) hold.active = false;
    try {
      if (advisory) await advisory.release();
    } finally {
      release(key);
    }
  }
}

/**
 * Runs `fn` while holding the lock `name` if nobody, in this process or on
 * another replica, holds or waits for it right now; otherwise returns
 * `{ acquired: false }` without running it. Never waits for the lock.
 */
export async function tryWithClusterLock<T>(
  name: string,
  fn: (lock: ClusterLockContext) => T | Promise<T>,
  options: ClusterLockOptions = {}
): Promise<TryLockResult<T>> {
  checkName("tryWithClusterLock", name);
  const key = lockKey(name, options);
  const held = heldLocks.getStore();
  const outer = held?.get(key);
  if (outer?.active) return { acquired: true, value: await fn({ signal: outer.signal }) };
  refuseInsideTransaction("tryWithClusterLock", name);

  if (!tryAcquire(key)) return { acquired: false };
  let advisory: AdvisoryLock | null = null;
  let hold: LockHold | null = null;
  try {
    if (isPostgres()) {
      advisory = await takeAdvisoryLock(name, options.pool ?? getLockPool(), false);
      if (!advisory) return { acquired: false };
    }
    hold = { active: true, signal: advisory?.signal ?? NEVER_ABORTED };
    return { acquired: true, value: await runHolding(key, held, hold, fn) };
  } finally {
    if (hold) hold.active = false;
    try {
      if (advisory) await advisory.release();
    } finally {
      release(key);
    }
  }
}

/**
 * withClusterLock for work that brings something up to date with the
 * database, such as pushing the current configuration to Caddy: a call made
 * while an earlier call of this process still waits for the lock (its work
 * has not started) joins that call and gets its result or error instead of
 * queueing work of its own. The joined work starts after both calls, so it
 * covers what either caller committed before calling. A burst of calls runs
 * the work at most twice per process: the run in progress and one after it.
 */
export async function withCoalescedClusterLock<T>(
  name: string,
  fn: (lock: ClusterLockContext) => T | Promise<T>,
  options: ClusterLockOptions = {}
): Promise<T> {
  checkName("withCoalescedClusterLock", name);
  const key = lockKey(name, options);
  // Held already: runs at once (joining a waiting run would wait for ourselves).
  if (heldLocks.getStore()?.get(key)?.active) return await withClusterLock(name, fn, options);
  refuseInsideTransaction("withCoalescedClusterLock", name);

  const waiting = coalescedRuns.get(key);
  if (waiting && !waiting.started) return (await waiting.promise) as T;

  const run: CoalescedRun = { promise: Promise.resolve(), started: false };
  const forget = () => {
    if (coalescedRuns.get(key) === run) coalescedRuns.delete(key);
  };
  run.promise = withClusterLock(
    name,
    (lock) => {
      run.started = true;
      forget();
      return fn(lock);
    },
    options
  );
  coalescedRuns.set(key, run);
  try {
    return (await run.promise) as T;
  } finally {
    forget();
  }
}
