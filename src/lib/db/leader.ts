/**
 * The job leader of PostgreSQL replicas (D7; ee/docs/high-availability.md,
 * "PostgreSQL replicas").
 *
 * Several web containers can share one PostgreSQL database. Every one of them
 * serves the dashboard, the API and the request-path routes, but the
 * background jobs (SERVER_JOBS in src/instrumentation.ts) run on exactly one:
 * the leader, the replica whose database session holds the advisory lock
 * pg_advisory_lock(ADVISORY_LOCK_NAMESPACE, LEADER_LOCK_ID).
 *
 * - Each replica keeps a connection of its own for this, outside the pool (a
 *   session lock belongs to the connection that took it), and tries
 *   pg_try_advisory_lock on it every LEADER_RETRY_INTERVAL_MS until it gets it.
 * - The leader checks on that connection every LEADER_HEARTBEAT_INTERVAL_MS
 *   that its session still holds the lock (pg_locks).
 * - Crash-only fencing: when the connection reports an error or its end, a
 *   check fails, takes longer than LEADER_HEARTBEAT_TIMEOUT_MS or finds the
 *   lock gone, or no check has succeeded for LEADER_FENCE_AFTER_MS (counted
 *   from when the last good check was sent), the replica stops leading at
 *   once: isLeader() turns false and the listeners stop the leader's jobs.
 *   Only then is the connection closed; the replica competes again on a new
 *   one. It never tries to repair a connection it can no longer vouch for.
 * - The server ends the session of a leader it can no longer reach after
 *   about 20 seconds (TCP keepalives and tcp_user_timeout, set for this
 *   session below), which frees the lock for a follower. The leader has
 *   fenced itself well before that (LEADER_FENCE_AFTER_MS). A session the
 *   server ends itself (a restart, pg_terminate_backend) closes the socket,
 *   which the leader notices at once.
 * - stop() (on SIGTERM and SIGINT) stops the jobs, then unlocks, so a rolling
 *   restart hands the jobs over within LEADER_RETRY_INTERVAL_MS.
 *
 * The lock elects who runs the jobs; it is not a fencing token for the
 * database. A job tick that was already running when its replica stopped
 * leading finishes on its own, so work that must never overlap also takes a
 * cluster lock (withClusterLock) or is idempotent.
 *
 * The process's elector lives on globalThis: Next.js can load this module
 * more than once in one process (instrumentation and route bundles).
 */
import pg from "pg";
import { ADVISORY_LOCK_NAMESPACE, LEADER_LOCK_ID, readPostgresConfig } from "./postgres";

/** How often a follower tries to take the lock. */
export const LEADER_RETRY_INTERVAL_MS = 3_000;
/** How often the leader checks that it still holds the lock. */
export const LEADER_HEARTBEAT_INTERVAL_MS = 2_000;
/** A check (or a lock attempt) that takes longer counts as failed. */
export const LEADER_HEARTBEAT_TIMEOUT_MS = 3_000;
/** The leader stops leading when no check sent within this long has succeeded. */
export const LEADER_FENCE_AFTER_MS = 6_000;
/** How long the listeners get to stop the leader's jobs before the lock is let go. */
export const LEADER_STOP_GRACE_MS = 2_000;
/** Reconnection attempts back off up to this delay. */
const MAX_RECONNECT_DELAY_MS = 30_000;
const CONNECT_TIMEOUT_MS = 5_000;
const CLOSE_TIMEOUT_MS = 2_000;

/**
 * What the server does with this session when the replica cannot be
 * reached: keepalive probes after 10 s of silence, every 3 s, 3 of them, and
 * unacknowledged data for 15 s end the session (and free the lock) after
 * about 20 seconds, more than three times LEADER_FENCE_AFTER_MS. Ignored on
 * Unix-domain sockets.
 */
const SESSION_TCP_SETTINGS =
  "SET tcp_keepalives_idle = 10; SET tcp_keepalives_interval = 3; SET tcp_keepalives_count = 3; SET tcp_user_timeout = 15000";
/** The session must never be ended for being idle (a database or role may set these). */
const SESSION_SETTINGS = "SET idle_session_timeout = 0; SET idle_in_transaction_session_timeout = 0";

const TRY_LOCK = "SELECT pg_try_advisory_lock($1::int, $2::int) AS acquired";
const UNLOCK = "SELECT pg_advisory_unlock($1::int, $2::int) AS released";
/** Whether this session holds the two-key advisory lock (classid, objid; objsubid 2 is the two-key form). */
const HOLDS_LOCK = `SELECT EXISTS (
  SELECT 1 FROM pg_locks
   WHERE locktype = 'advisory' AND classid = $1::int::oid AND objid = $2::int::oid AND objsubid = 2
     AND pid = pg_backend_pid() AND granted
) AS held`;

export type LeaderState =
  /** Not started (SQLite, or before start-up). */
  | "off"
  /** Opening the connection, or waiting to open it again. */
  | "connecting"
  /** Connected; another replica holds the lock. */
  | "follower"
  | "leader"
  /** Stopped for good (shutdown). */
  | "stopped";

/** Why the elector last let go of its connection: fixed text, never the server's words. */
const FAILURES = {
  connect: "Cannot connect to PostgreSQL for leader election",
  connection: "The leader election connection was lost",
  lock: "The attempt to take the leader lock failed",
  heartbeat: "The leader heartbeat failed or timed out",
  "lock-lost": "The leader lock is no longer held by this replica",
  fence: "No leader heartbeat succeeded in time",
  unlock: "Releasing the leader lock failed",
} as const;
type Failure = keyof typeof FAILURES;

export type LeaderStatus = {
  state: LeaderState;
  leader: boolean;
  /** When this replica last became the leader, while it leads. */
  leaderSince: string | null;
  /** The last heartbeat that confirmed the lock, while it leads. */
  lastHeartbeatAt: string | null;
  /** How many times this process became the leader. */
  terms: number;
  /** Why the connection was last given up (fixed text), until the next successful connection. */
  lastError: string | null;
  lastErrorAt: string | null;
};

export const LEADER_STATUS_OFF: LeaderStatus = {
  state: "off",
  leader: false,
  leaderSince: null,
  lastHeartbeatAt: null,
  terms: 0,
  lastError: null,
  lastErrorAt: null,
};

export type LeadershipListener = (leader: boolean) => void | Promise<void>;

export type LeaderElectorOptions = {
  /** The dedicated connection (default: a pg.Client from DATABASE_URL, outside the pool). */
  createConnection?: () => pg.Client;
  /** The second key of the lock (tests use their own). */
  lockId?: number;
  retryIntervalMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  fenceAfterMs?: number;
  stopGraceMs?: number;
  /** A monotonic clock in milliseconds (default performance.now). */
  now?: () => number;
  /** Logs the transitions (default true). */
  log?: boolean;
};

class TimeoutError extends Error {
  constructor(what: string) {
    super(`${what} timed out`);
    this.name = "TimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(what)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The default connection: the pool's settings, its own application_name, client keepalives. */
function defaultConnection(): pg.Client {
  return new pg.Client({
    ...readPostgresConfig(),
    application_name: "ingressi-leader",
    statement_timeout: LEADER_HEARTBEAT_TIMEOUT_MS * 2,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5_000,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
}

/**
 * Closes a connection the elector no longer vouches for. Closing it frees
 * the lock on the server if the session still held it. A socket that does
 * not close in time (the server is unreachable) is destroyed.
 */
async function retire(connection: pg.Client): Promise<void> {
  connection.removeAllListeners("error");
  connection.removeAllListeners("end");
  // node-postgres reports a failure of an unwatched connection as an
  // "error" event, which would end the process.
  connection.on("error", () => {});
  try {
    await withTimeout(connection.end(), CLOSE_TIMEOUT_MS, "closing the connection");
  } catch {
    (connection as unknown as { connection?: { stream?: { destroy?: () => void } } }).connection?.stream?.destroy?.();
  }
}

export class LeaderElector {
  private readonly createConnection: () => pg.Client;
  private readonly lockId: number;
  private readonly retryIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly fenceAfterMs: number;
  private readonly stopGraceMs: number;
  private readonly now: () => number;
  private readonly log: boolean;

  private state: LeaderState = "off";
  /** Raised whenever a connection is given up: work of an older generation stops. */
  private generation = 0;
  private connection: pg.Client | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fenceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Monotonic time until which the last good check vouches for the lock. */
  private validUntil = 0;
  /** Monotonic time before which this replica does not try to lead (after stepping down). */
  private holdOffUntil = 0;
  private failures = 0;
  private tcpSettingsWarned = false;
  private readonly listeners = new Set<LeadershipListener>();
  private firstAnswer: { promise: Promise<void>; resolve: () => void } | null = null;
  private info: Omit<LeaderStatus, "state" | "leader"> = { ...LEADER_STATUS_OFF };

  constructor(options: LeaderElectorOptions = {}) {
    this.createConnection = options.createConnection ?? defaultConnection;
    this.lockId = options.lockId ?? LEADER_LOCK_ID;
    this.retryIntervalMs = options.retryIntervalMs ?? LEADER_RETRY_INTERVAL_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? LEADER_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? LEADER_HEARTBEAT_TIMEOUT_MS;
    this.fenceAfterMs = options.fenceAfterMs ?? LEADER_FENCE_AFTER_MS;
    this.stopGraceMs = options.stopGraceMs ?? LEADER_STOP_GRACE_MS;
    this.now = options.now ?? (() => performance.now());
    this.log = options.log ?? true;
  }

  /** This replica leads, and its last check vouches for the lock. */
  isLeader(): boolean {
    return this.state === "leader" && this.now() < this.validUntil;
  }

  status(): LeaderStatus {
    const leader = this.isLeader();
    return {
      ...this.info,
      state: this.state === "leader" && !leader ? "connecting" : this.state,
      leader,
      leaderSince: leader ? this.info.leaderSince : null,
      lastHeartbeatAt: leader ? this.info.lastHeartbeatAt : null,
    };
  }

  /**
   * Calls `listener(true)` when this replica becomes the leader and
   * `listener(false)` when it stops. Returns the function that unsubscribes.
   */
  onLeadershipChange(listener: LeadershipListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Starts competing for the lock. Resolves once the first attempt has an
   * answer (this replica leads, another one does, or the database cannot be
   * reached yet); it keeps trying in the background either way.
   */
  start(): Promise<void> {
    if (this.state !== "off" && this.state !== "stopped") return this.firstAnswer?.promise ?? Promise.resolve();
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    this.firstAnswer = { promise, resolve };
    this.failures = 0;
    this.holdOffUntil = 0;
    void this.connect();
    return promise;
  }

  /**
   * Stops for good: the listeners stop the jobs first, then the lock is
   * released and the connection closed (SIGTERM, SIGINT, tests).
   */
  async stop(): Promise<void> {
    if (this.state === "off" || this.state === "stopped") return;
    const wasLeader = this.state === "leader";
    this.generation += 1;
    this.clearTimers();
    this.state = "stopped";
    this.validUntil = 0;
    const connection = this.connection;
    this.connection = null;
    this.answered();
    if (wasLeader) {
      if (this.log) console.log("[leader] This replica is stopping: it stops its background jobs and hands the lead over");
      await this.notify(false);
    }
    if (!connection) return;
    if (wasLeader) {
      await withTimeout(connection.query(UNLOCK, [ADVISORY_LOCK_NAMESPACE, this.lockId]), CLOSE_TIMEOUT_MS, "unlock").catch(
        () => undefined
      );
    }
    await retire(connection);
  }

  /**
   * Gives the lead up for `holdOffMs`: the listeners stop the jobs, the lock
   * is released, and this replica tries to lead again only afterwards, so
   * another one can (a start-up task that must succeed failed here).
   */
  async stepDown(reason: string, holdOffMs: number): Promise<void> {
    if (this.state !== "leader") return;
    const generation = this.generation;
    const connection = this.connection;
    this.state = "follower";
    this.validUntil = 0;
    this.clearTimers();
    this.holdOffUntil = this.now() + holdOffMs;
    if (this.log) {
      console.error(`[leader] This replica gives the lead up for ${Math.round(holdOffMs / 1000)} s: ${reason}`);
    }
    await this.notify(false);
    if (generation !== this.generation || !connection) return;
    try {
      await withTimeout(connection.query(UNLOCK, [ADVISORY_LOCK_NAMESPACE, this.lockId]), this.heartbeatTimeoutMs, "unlock");
    } catch (error) {
      this.lose(generation, "unlock", error);
      return;
    }
    if (generation !== this.generation) return;
    this.schedule(() => this.attempt(generation), holdOffMs);
  }

  // ── Internals ──

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.fenceTimer) clearTimeout(this.fenceTimer);
    this.timer = null;
    this.fenceTimer = null;
  }

  private schedule(fn: () => Promise<void> | void, ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void fn();
    }, Math.max(0, ms));
    this.timer.unref?.();
  }

  private answered(): void {
    this.firstAnswer?.resolve();
  }

  private recordFailure(failure: Failure, error: unknown): void {
    this.info.lastError = FAILURES[failure];
    this.info.lastErrorAt = new Date().toISOString();
    if (this.log) {
      const detail = error === null || error === undefined ? "" : `: ${message(error)}`;
      console.error(`[leader] ${FAILURES[failure]}${detail}`);
    }
  }

  /** Listeners run together; stopping waits for them at most stopGraceMs. */
  private notify(leader: boolean): Promise<void> {
    const runs = [...this.listeners].map(async (listener) => {
      await listener(leader);
    });
    const settled = Promise.allSettled(runs).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") console.error("[leader] A leadership listener failed:", result.reason);
      }
    });
    if (leader) return settled;
    return Promise.race([settled, delay(this.stopGraceMs)]);
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    this.state = "connecting";
    let connection: pg.Client;
    try {
      connection = this.createConnection();
    } catch (error) {
      this.lose(generation, "connect", error);
      return;
    }
    this.connection = connection;
    connection.on("error", (error) => this.lose(generation, "connection", error));
    connection.on("end", () => this.lose(generation, "connection", null));
    try {
      await withTimeout(connection.connect(), CONNECT_TIMEOUT_MS + 1_000, "connecting");
      await withTimeout(connection.query(SESSION_SETTINGS), this.heartbeatTimeoutMs, "session settings");
    } catch (error) {
      this.lose(generation, "connect", error);
      return;
    }
    try {
      await withTimeout(connection.query(SESSION_TCP_SETTINGS), this.heartbeatTimeoutMs, "TCP settings");
    } catch (error) {
      if (generation !== this.generation) return;
      if (this.log && !this.tcpSettingsWarned) {
        this.tcpSettingsWarned = true;
        console.warn(
          "[leader] The server did not take the TCP keepalive settings of the leader election session; " +
            `an unreachable leader's lock may take longer to free: ${message(error)}`
        );
      }
    }
    if (generation !== this.generation) return;
    this.failures = 0;
    this.info.lastError = null;
    this.info.lastErrorAt = null;
    this.state = "follower";
    this.schedule(() => this.attempt(generation), this.holdOffUntil - this.now());
  }

  private async attempt(generation: number): Promise<void> {
    const connection = this.connection;
    if (generation !== this.generation || !connection || this.state !== "follower") return;
    const sentAt = this.now();
    let acquired: boolean;
    try {
      const { rows } = await withTimeout(
        connection.query<{ acquired: boolean }>(TRY_LOCK, [ADVISORY_LOCK_NAMESPACE, this.lockId]),
        this.heartbeatTimeoutMs,
        "taking the leader lock"
      );
      acquired = rows[0]?.acquired === true;
    } catch (error) {
      this.lose(generation, "lock", error);
      return;
    }
    // Superseded meanwhile: whoever retired this connection closed it, which
    // frees a lock it may just have taken.
    if (generation !== this.generation) return;
    if (!acquired) {
      this.answered();
      this.schedule(() => this.attempt(generation), this.retryIntervalMs);
      return;
    }
    this.state = "leader";
    this.info.terms += 1;
    this.info.leaderSince = new Date().toISOString();
    this.confirm(generation, sentAt);
    if (this.log) console.log("[leader] This replica is now the leader: it runs the background jobs");
    void this.notify(true);
    this.answered();
    this.schedule(() => this.heartbeat(generation), this.heartbeatIntervalMs);
  }

  /** A check sent at `sentAt` succeeded: the lock is vouched for until sentAt + fenceAfterMs. */
  private confirm(generation: number, sentAt: number): void {
    this.validUntil = sentAt + this.fenceAfterMs;
    this.info.lastHeartbeatAt = new Date().toISOString();
    this.armFence(generation);
  }

  private armFence(generation: number): void {
    if (this.fenceTimer) clearTimeout(this.fenceTimer);
    this.fenceTimer = setTimeout(() => {
      this.fenceTimer = null;
      if (generation !== this.generation || this.state !== "leader") return;
      if (this.now() >= this.validUntil) this.lose(generation, "fence", null);
      else this.armFence(generation);
    }, Math.max(1, this.validUntil - this.now()));
    this.fenceTimer.unref?.();
  }

  private async heartbeat(generation: number): Promise<void> {
    const connection = this.connection;
    if (generation !== this.generation || !connection || this.state !== "leader") return;
    const sentAt = this.now();
    try {
      const { rows } = await withTimeout(
        connection.query<{ held: boolean }>(HOLDS_LOCK, [ADVISORY_LOCK_NAMESPACE, this.lockId]),
        this.heartbeatTimeoutMs,
        "the leader heartbeat"
      );
      if (generation !== this.generation || this.state !== "leader") return;
      if (rows[0]?.held !== true) {
        this.lose(generation, "lock-lost", null);
        return;
      }
    } catch (error) {
      this.lose(generation, "heartbeat", error);
      return;
    }
    this.confirm(generation, sentAt);
    this.schedule(() => this.heartbeat(generation), this.heartbeatIntervalMs);
  }

  /**
   * Gives the connection of `generation` up: stops leading first (the jobs
   * stop), then closes it and connects again after a delay.
   */
  private lose(generation: number, failure: Failure, error: unknown): void {
    if (generation !== this.generation || this.state === "stopped" || this.state === "off") return;
    this.generation += 1;
    const connection = this.connection;
    this.connection = null;
    this.clearTimers();
    const wasLeader = this.state === "leader";
    this.state = "connecting";
    this.validUntil = 0;
    this.recordFailure(failure, error);
    if (wasLeader && this.log) {
      console.error("[leader] This replica stopped leading: its background jobs are stopped and it competes again");
    }
    const stopped = wasLeader ? this.notify(false) : Promise.resolve();
    this.answered();
    void stopped.then(() => (connection ? retire(connection) : undefined));
    this.failures += 1;
    const backoff = Math.min(this.retryIntervalMs * 2 ** (this.failures - 1), MAX_RECONNECT_DELAY_MS);
    this.schedule(() => this.connect(), Math.max(backoff, this.holdOffUntil - this.now()));
  }
}

// ── The process's elector ──

type GlobalLeaderState = typeof globalThis & { __ingressiLeaderElector?: LeaderElector };
const globalLeader = globalThis as GlobalLeaderState;

/** The process's elector, created on first use. */
export function getLeaderElector(): LeaderElector {
  return (globalLeader.__ingressiLeaderElector ??= new LeaderElector());
}

/** Whether this replica leads (false on SQLite and before the election started). */
export function isLeader(): boolean {
  return globalLeader.__ingressiLeaderElector?.isLeader() ?? false;
}

export function onLeadershipChange(listener: LeadershipListener): () => void {
  return getLeaderElector().onLeadershipChange(listener);
}

/** The election as this process sees it. */
export function getLeaderStatus(): LeaderStatus {
  return globalLeader.__ingressiLeaderElector?.status() ?? LEADER_STATUS_OFF;
}

/** Stops the process's election (the jobs first, then the lock); the next getLeaderElector() starts afresh. */
export async function stopLeaderElection(): Promise<void> {
  const elector = globalLeader.__ingressiLeaderElector;
  globalLeader.__ingressiLeaderElector = undefined;
  await elector?.stop();
}

/** Tests: use `elector` as the process's elector (null forgets it without stopping it). */
export function setLeaderElectorForTests(elector: LeaderElector | null): void {
  globalLeader.__ingressiLeaderElector = elector ?? undefined;
}
