/**
 * Rate limiters: failed credential checks (dashboard, portal and directory
 * sign-in, password confirmations) and request limits (instance sync, pull
 * replicas, AI questions). `maxAttempts` attempts within `windowMs` block a
 * key for `blockMs`.
 *
 * Where the counters live (src/lib/db/README.md, "Events and shared state"):
 *
 *  - memory: this process's tables, bounded to `maxKeys` keys each. The
 *    default on SQLite, where one process serves everything.
 *  - database: the rate_limit_counters table, so every web replica counts
 *    towards the same limit. The default on PostgreSQL, where several
 *    replicas may share the database. Each operation is one or two
 *    single-statement writes (no transaction, so no write lock): the key's
 *    row serialises concurrent attempts, whichever replica makes them. Rows
 *    past their expiry are pruned (src/lib/shared-runtime-state.ts).
 *
 * Both behave the same. A limiter's `name` keeps its counters apart from
 * every other limiter's in the shared table: give each limiter its own.
 */
import { createHash } from "node:crypto";
import { and, eq, lt, sql, type SQL } from "drizzle-orm";
import { appDb } from "./db";
import { rateLimitCounters } from "./db/schema";
import { isPostgres } from "./db/dialect";
import { first } from "./db/ops";

type RateLimitEntry = {
  attempts: number;
  firstAttemptTimestamp: number;
  blockedUntil?: number;
};

export type RateLimitOutcome = {
  blocked: boolean;
  retryAfterMs?: number;
};

export type RateLimitStore = "memory" | "database";

export type RateLimiterOptions = {
  /**
   * The limiter's name in the shared table: lower-case letters, digits and
   * "-", one per limiter.
   */
  name: string;
  /** Attempts within `windowMs` that trigger a block. */
  maxAttempts: number;
  windowMs: number;
  /**
   * How long a key stays blocked once it reaches `maxAttempts`, or "window"
   * to block it only until its current window ends (a fixed-window limit).
   */
  blockMs: number | "window";
  /** Upper bound on tracked keys in memory; defaults to MAX_TRACKED_KEYS. */
  maxKeys?: number;
  /** Where the counters live; by default the database on PostgreSQL and memory on SQLite. */
  store?: RateLimitStore;
};

export type RateLimiter = {
  readonly name: string;
  isRateLimited(key: string): Promise<RateLimitOutcome>;
  /** Counts one attempt (a failed login, or any request for a request limit). */
  registerAttempt(key: string): Promise<RateLimitOutcome>;
  resetAttempts(key: string): Promise<void>;
  /**
   * Holds a place for an attempt whose outcome is not known yet, so that
   * concurrent attempts cannot all pass the check before any of them is
   * counted. Resolves to null when the key is blocked or its counted and held
   * attempts already reach `maxAttempts`. Otherwise to a function that gives
   * the place back; call it once the attempt ends, whatever the outcome, and
   * register a failure separately. A place held in the database is given
   * back by itself after HOLD_MS (a replica that stopped mid-attempt).
   */
  reserveAttempt(key: string): Promise<(() => Promise<void>) | null>;
  /** Forgets every counter of this limiter (tests). */
  clear(): Promise<void>;
};

/** Thresholds for credential checks (portal login, password change, account linking). */
export const LOGIN_RATE_LIMIT = {
  maxAttempts: Number(process.env.LOGIN_MAX_ATTEMPTS ?? 5),
  windowMs: Number(process.env.LOGIN_WINDOW_MS ?? 5 * 60 * 1000),
  blockMs: Number(process.env.LOGIN_BLOCK_MS ?? 15 * 60 * 1000),
} as const;

// Keys are partly client-chosen (IPs, usernames), so each table is bounded.
// Callers keep keys short (hashes, validated IPs), which bounds memory too.
export const MAX_TRACKED_KEYS = 10_000;

/** How long a place held in the database counts when it is never given back. */
export const HOLD_MS = 60_000;

const LIMITER_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
/** Keys longer than this are stored as their SHA-256, so the shared table's keys stay small. */
const MAX_STORED_KEY_LENGTH = 200;

type LimiterStore = Omit<RateLimiter, "name">;

// ── Memory ──

type MemoryLimiter = {
  isRateLimited(key: string): RateLimitOutcome;
  registerAttempt(key: string): RateLimitOutcome;
  resetAttempts(key: string): void;
  reserveAttempt(key: string): (() => void) | null;
  clear(): void;
};

/** The in-memory tables of one limiter. */
function createMemoryLimiter(options: RateLimiterOptions): MemoryLimiter {
  const { maxAttempts, windowMs, blockMs } = options;
  const maxKeys = options.maxKeys ?? MAX_TRACKED_KEYS;
  const attempts = new Map<string, RateLimitEntry>();
  // Attempts in progress per key. An entry lives only while its requests are
  // in flight and holds at most maxAttempts, so the map is bounded by the
  // number of concurrent requests.
  const reserved = new Map<string, number>();

  function getEntry(key: string, now: number): RateLimitEntry | undefined {
    const entry = attempts.get(key);
    if (!entry) {
      return undefined;
    }

    // Unblock if the penalty period has elapsed.
    if (entry.blockedUntil && entry.blockedUntil <= now) {
      attempts.delete(key);
      return undefined;
    }

    // Reset the window once the observation window expires.
    if (!entry.blockedUntil && entry.firstAttemptTimestamp + windowMs <= now) {
      attempts.delete(key);
      return undefined;
    }

    return entry;
  }

  /**
   * Make room for one more key: drop expired entries, then the oldest entries
   * that are not currently blocked, and only then the oldest blocked ones — so
   * flooding the table with fresh keys does not lift an active block.
   */
  function makeRoom(now: number): void {
    if (attempts.size < maxKeys) return;
    for (const key of [...attempts.keys()]) getEntry(key, now);
    // Map iteration follows insertion order, so the first keys are the oldest.
    for (const [key, entry] of attempts) {
      if (attempts.size < maxKeys) return;
      if (!entry.blockedUntil) attempts.delete(key);
    }
    for (const key of attempts.keys()) {
      if (attempts.size < maxKeys) return;
      attempts.delete(key);
    }
  }

  function isRateLimited(key: string): RateLimitOutcome {
    const now = Date.now();
    const entry = getEntry(key, now);
    if (!entry) {
      return { blocked: false };
    }

    if (entry.blockedUntil && entry.blockedUntil > now) {
      return { blocked: true, retryAfterMs: entry.blockedUntil - now };
    }

    return { blocked: false };
  }

  function registerAttempt(key: string): RateLimitOutcome {
    const now = Date.now();
    let entry = getEntry(key, now);

    // getEntry drops elapsed blocks, so a remaining blockedUntil is active.
    if (entry?.blockedUntil) {
      return { blocked: true, retryAfterMs: entry.blockedUntil - now };
    }

    if (!entry) {
      makeRoom(now);
      entry = { attempts: 0, firstAttemptTimestamp: now };
      attempts.set(key, entry);
    }

    entry.attempts += 1;

    if (entry.attempts >= maxAttempts) {
      const blockedUntil = blockMs === "window" ? entry.firstAttemptTimestamp + windowMs : now + blockMs;
      entry.attempts = 0;
      entry.firstAttemptTimestamp = now;
      entry.blockedUntil = blockedUntil;
      return { blocked: true, retryAfterMs: blockedUntil - now };
    }

    return { blocked: false };
  }

  function resetAttempts(key: string): void {
    attempts.delete(key);
  }

  function reserveAttempt(key: string): (() => void) | null {
    const entry = getEntry(key, Date.now());
    const held = reserved.get(key) ?? 0;
    if (entry?.blockedUntil || (entry?.attempts ?? 0) + held >= maxAttempts) {
      return null;
    }
    reserved.set(key, held + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (reserved.get(key) ?? 1) - 1;
      if (remaining > 0) reserved.set(key, remaining);
      else reserved.delete(key);
    };
  }

  function clear(): void {
    attempts.clear();
    reserved.clear();
  }

  return { isRateLimited, registerAttempt, resetAttempts, reserveAttempt, clear };
}

// ── Database ──

const counters = rateLimitCounters;

/** A time or duration in milliseconds as a 64-bit integer (PostgreSQL would take a bare parameter for int4). */
function ms(value: number): SQL {
  return sql`CAST(${Math.trunc(value)} AS bigint)`;
}

/** The larger of a column and a value, on both dialects (SQLite's two-argument max is PostgreSQL's greatest). */
function atLeast(column: typeof counters.expiresAtMs, value: number): SQL {
  return sql`CASE WHEN ${column} > ${ms(value)} THEN ${column} ELSE ${ms(value)} END`;
}

function storedKey(key: string): string {
  return key.length <= MAX_STORED_KEY_LENGTH ? key : `sha256:${createHash("sha256").update(key, "utf8").digest("base64url")}`;
}

function outcome(blockedUntilMs: number | undefined, now: number): RateLimitOutcome {
  return blockedUntilMs !== undefined && blockedUntilMs > now ? { blocked: true, retryAfterMs: blockedUntilMs - now } : { blocked: false };
}

/**
 * The counters of one limiter in rate_limit_counters, with the memory
 * limiter's rules: each statement reads the row as getEntry() does (a block
 * or a window that ended counts as no row) and writes the result in one go.
 */
function createDatabaseLimiter(options: RateLimiterOptions): LimiterStore {
  const { name, maxAttempts, windowMs, blockMs } = options;
  const prefix = `${name}:`;
  /** How long a row can matter after its last write: the window, the block and a held place have all ended by then. */
  const span = Math.max(windowMs, blockMs === "window" ? windowMs : blockMs, HOLD_MS);
  const bucketOf = (key: string) => `${prefix}${storedKey(key)}`;

  /** SQL for the row as getEntry() sees it at `now`. */
  function rowState(now: number) {
    const blocked = sql`${counters.blockedUntilMs} > ${ms(now)}`;
    // Nothing counted in a live window: a block that ended, a window that
    // ended, or no attempt counted yet (a row only a reservation created).
    const fresh = sql`(${counters.blockedUntilMs} > 0 OR ${counters.attempts} = 0 OR ${counters.windowStartMs} + ${ms(windowMs)} <= ${ms(now)})`;
    const counted = sql`(CASE WHEN ${fresh} THEN 0 ELSE ${counters.attempts} END)`;
    const windowStart = sql`(CASE WHEN ${fresh} THEN ${ms(now)} ELSE ${counters.windowStartMs} END)`;
    const held = sql`(CASE WHEN ${counters.heldUntilMs} > ${ms(now)} THEN ${counters.held} ELSE 0 END)`;
    return { blocked, counted, windowStart, held };
  }

  return {
    async isRateLimited(key) {
      const now = Date.now();
      const row = await first(appDb
        .select({ blockedUntilMs: counters.blockedUntilMs })
        .from(counters)
        .where(eq(counters.bucket, bucketOf(key)))
        .limit(1));
      return outcome(row?.blockedUntilMs, now);
    },

    async registerAttempt(key) {
      const now = Date.now();
      const { blocked, counted, windowStart } = rowState(now);
      const reached = sql`(${counted} + 1 >= ${maxAttempts})`;
      const blockUntil = blockMs === "window" ? sql`(${windowStart} + ${ms(windowMs)})` : ms(now + blockMs);
      const firstBlocks = maxAttempts <= 1;
      const row = await first(appDb
        .insert(counters)
        .values({
          bucket: bucketOf(key),
          attempts: firstBlocks ? 0 : 1,
          windowStartMs: now,
          blockedUntilMs: firstBlocks ? now + (blockMs === "window" ? windowMs : blockMs) : 0,
          held: 0,
          heldUntilMs: 0,
          expiresAtMs: now + span,
        })
        .onConflictDoUpdate({
          target: counters.bucket,
          set: {
            attempts: sql`CASE WHEN ${blocked} THEN ${counters.attempts} WHEN ${reached} THEN 0 ELSE ${counted} + 1 END`,
            windowStartMs: sql`CASE WHEN ${blocked} THEN ${counters.windowStartMs} WHEN ${reached} THEN ${ms(now)} ELSE ${windowStart} END`,
            blockedUntilMs: sql`CASE WHEN ${blocked} THEN ${counters.blockedUntilMs} WHEN ${reached} THEN ${blockUntil} ELSE ${ms(0)} END`,
            expiresAtMs: atLeast(counters.expiresAtMs, now + span),
          },
        })
        .returning({ blockedUntilMs: counters.blockedUntilMs }));
      return outcome(row?.blockedUntilMs, now);
    },

    async resetAttempts(key) {
      // Places held for attempts in progress stay.
      await appDb.update(counters).set({ attempts: 0, blockedUntilMs: 0 }).where(eq(counters.bucket, bucketOf(key)));
    },

    async reserveAttempt(key) {
      const now = Date.now();
      const bucket = bucketOf(key);
      await appDb
        .insert(counters)
        .values({ bucket, attempts: 0, windowStartMs: now, blockedUntilMs: 0, held: 0, heldUntilMs: 0, expiresAtMs: now + span })
        .onConflictDoNothing({ target: counters.bucket });
      const { blocked, counted, held } = rowState(now);
      const row = await first(appDb
        .update(counters)
        .set({
          held: sql`${held} + 1`,
          heldUntilMs: ms(now + HOLD_MS),
          expiresAtMs: atLeast(counters.expiresAtMs, now + span),
        })
        .where(and(eq(counters.bucket, bucket), sql`NOT (${blocked})`, sql`${counted} + ${held} < ${maxAttempts}`))
        .returning({ bucket: counters.bucket }));
      if (!row) return null;
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          await appDb
            .update(counters)
            .set({ held: sql`CASE WHEN ${counters.held} > 0 THEN ${counters.held} - 1 ELSE 0 END` })
            .where(eq(counters.bucket, bucket));
        } catch (error) {
          // The place is given back by itself after HOLD_MS.
          console.warn(`[rate-limit] Could not give back a place of the ${name} limiter:`, error instanceof Error ? error.message : typeof error);
        }
      };
    },

    async clear() {
      await appDb.delete(counters).where(sql`substr(${counters.bucket}, 1, ${prefix.length}) = ${prefix}`);
    },
  };
}

/** Deletes the counters whose window, block and held places have all ended (the prune job). Returns how many. */
export async function pruneRateLimitCounters(now: number = Date.now()): Promise<number> {
  const rows = await appDb
    .delete(rateLimitCounters)
    .where(lt(rateLimitCounters.expiresAtMs, now))
    .returning({ bucket: rateLimitCounters.bucket });
  return rows.length;
}

// ── Limiters ──

/** Where limiters keep their counters unless told: the database on PostgreSQL (several replicas), memory on SQLite. */
export function defaultRateLimitStore(): RateLimitStore {
  return isPostgres() ? "database" : "memory";
}

/**
 * A limiter with its own counters, in memory or in the shared table (see
 * the module comment). `maxAttempts` attempts within `windowMs` block a key
 * for `blockMs`.
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  if (!LIMITER_NAME.test(options.name)) {
    throw new Error(`Invalid rate limiter name ${JSON.stringify(options.name)}: lower-case letters, digits and "-"`);
  }
  const memory = createMemoryLimiter(options);
  const database = createDatabaseLimiter(options);
  const shared = () => (options.store ?? defaultRateLimitStore()) === "database";
  return {
    name: options.name,
    async isRateLimited(key) {
      return shared() ? await database.isRateLimited(key) : memory.isRateLimited(key);
    },
    async registerAttempt(key) {
      return shared() ? await database.registerAttempt(key) : memory.registerAttempt(key);
    },
    async resetAttempts(key) {
      if (shared()) await database.resetAttempts(key);
      else memory.resetAttempts(key);
    },
    async reserveAttempt(key) {
      if (shared()) return await database.reserveAttempt(key);
      const release = memory.reserveAttempt(key);
      return release ? async () => release() : null;
    },
    async clear() {
      memory.clear();
      if (shared()) await database.clear();
    },
  };
}

// Shared limiter for the dashboard credential routes; callers namespace keys.
const defaultLimiter = createRateLimiter({ name: "credentials", ...LOGIN_RATE_LIMIT });

export const isRateLimited = defaultLimiter.isRateLimited;
export const registerFailedAttempt = defaultLimiter.registerAttempt;
export const resetAttempts = defaultLimiter.resetAttempts;
