/**
 * Short-lived values one request leaves for a later one (src/lib/db/README.md,
 * "Events and shared state"): how a sign-in waiting for its second factor
 * started, the TOTP codes that already signed an account in, the challenges
 * a master issued to pull replicas, sync-seal nonces. With several
 * web replicas (PostgreSQL) the later request may land on another replica,
 * so there the values live in the shared_runtime_entries table; with one
 * process (SQLite) they stay in a bounded map in memory, as before.
 *
 * Every value has an expiry and is never read after it. `take` reads and
 * removes a value in one statement, so two replicas never both take it.
 * Writes run in a savepoint when the caller is in a transaction (a sign-in
 * hook): bookkeeping must not end the caller's transaction when it fails.
 *
 * Also the prune job of every table of shared runtime state
 * (pruneSharedRuntimeState): expired entries, rate limiter counters and
 * Better Auth's rate limit rows.
 */
import { eq, gt, lt, and, sql } from "drizzle-orm";
import { appDb } from "./db";
import { authRateLimits, sharedRuntimeEntries } from "./db/schema";
import { isPostgres } from "./db/dialect";
import { first, recoverable } from "./db/ops";
import { pruneRateLimitCounters } from "./rate-limit";

export type RuntimeEntryStore = "memory" | "database";

export type RuntimeEntries<T> = {
  readonly scope: string;
  /** Stores `value` under `key` for `ttlMs`, replacing what was there. */
  put(key: string, value: T, ttlMs: number): Promise<void>;
  /** The value under `key`, or null when there is none or it expired. */
  get(key: string): Promise<T | null>;
  /** Reads and removes the value under `key`; null when there is none or it expired. */
  take(key: string): Promise<T | null>;
  delete(key: string): Promise<void>;
  /** Forgets every value of this scope (tests). */
  clear(): Promise<void>;
};

export type RuntimeEntriesOptions<T> = {
  /** At most this many values in memory; the oldest go first. */
  maxEntries: number;
  /** Whether a value read back from the database is one (stored values are JSON). */
  isValue: (value: unknown) => value is T;
  /** Default: the database on PostgreSQL, memory on SQLite. */
  store?: RuntimeEntryStore;
};

const SCOPE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_KEY_LENGTH = 200;
const MAX_VALUE_LENGTH = 4_000;

type MemoryEntry<T> = { value: T; expiresAt: number };

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

/** Values of one scope, kept per the store in effect when each call runs. */
export function defineRuntimeEntries<T>(scope: string, options: RuntimeEntriesOptions<T>): RuntimeEntries<T> {
  if (!SCOPE.test(scope)) throw new Error(`Invalid runtime state scope ${JSON.stringify(scope)}`);
  const prefix = `${scope}:`;
  const memory = new Map<string, MemoryEntry<T>>();
  const shared = () => (options.store ?? (isPostgres() ? "database" : "memory")) === "database";

  const keyOf = (key: string) => {
    if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) throw new Error(`Invalid ${scope} key`);
    return `${prefix}${key}`;
  };

  function parse(text: string | null | undefined): T | null {
    if (typeof text !== "string") return null;
    try {
      const value: unknown = JSON.parse(text);
      return options.isValue(value) ? value : null;
    } catch {
      return null;
    }
  }

  function memoryGet(key: string, now: number): T | null {
    const entry = memory.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      memory.delete(key);
      return null;
    }
    return entry.value;
  }

  return {
    scope,

    async put(key, value, ttlMs) {
      const id = keyOf(key);
      const expiresAt = Date.now() + ttlMs;
      if (!shared()) {
        // Re-inserted at the end: the map's order is the eviction order.
        memory.delete(id);
        if (memory.size >= options.maxEntries) {
          const oldest = memory.keys().next();
          if (!oldest.done) memory.delete(oldest.value);
        }
        memory.set(id, { value, expiresAt });
        return;
      }
      const text = JSON.stringify(value);
      if (text.length > MAX_VALUE_LENGTH) throw new Error(`A ${scope} value is too large`);
      const expires = isoAt(expiresAt);
      await recoverable(async () => {
        await appDb
          .insert(sharedRuntimeEntries)
          .values({ key: id, value: text, expiresAt: expires })
          .onConflictDoUpdate({ target: sharedRuntimeEntries.key, set: { value: text, expiresAt: expires } });
      });
    },

    async get(key) {
      const id = keyOf(key);
      if (!shared()) return memoryGet(id, Date.now());
      const row = await first(appDb
        .select({ value: sharedRuntimeEntries.value })
        .from(sharedRuntimeEntries)
        .where(and(eq(sharedRuntimeEntries.key, id), gt(sharedRuntimeEntries.expiresAt, isoAt(Date.now()))))
        .limit(1));
      return parse(row?.value);
    },

    async take(key) {
      const id = keyOf(key);
      if (!shared()) {
        const value = memoryGet(id, Date.now());
        memory.delete(id);
        return value;
      }
      const now = isoAt(Date.now());
      const row = await recoverable(async () =>
        await first(appDb
          .delete(sharedRuntimeEntries)
          .where(eq(sharedRuntimeEntries.key, id))
          .returning({ value: sharedRuntimeEntries.value, expiresAt: sharedRuntimeEntries.expiresAt }))
      );
      return row && row.expiresAt > now ? parse(row.value) : null;
    },

    async delete(key) {
      const id = keyOf(key);
      memory.delete(id);
      if (shared()) await recoverable(async () => { await appDb.delete(sharedRuntimeEntries).where(eq(sharedRuntimeEntries.key, id)); });
    },

    async clear() {
      memory.clear();
      if (shared()) {
        await appDb.delete(sharedRuntimeEntries).where(sql`substr(${sharedRuntimeEntries.key}, 1, ${prefix.length}) = ${prefix}`);
      }
    },
  };
}

// ── Pruning ──

/** Better Auth's rate limit rows older than this are of no use (its windows are seconds to minutes). */
export function authRateLimitRetentionMs(): number {
  const window = Number(process.env.AUTH_RATE_LIMIT_WINDOW ?? 60);
  return Math.max(60 * 60_000, (Number.isFinite(window) ? window : 60) * 2_000);
}

export type PruneResult = { entries: number; rateLimitCounters: number; authRateLimits: number };

/**
 * Deletes what has expired in the shared runtime state tables. On SQLite
 * they are empty (one process keeps the state in memory), so this finds
 * nothing there.
 */
export async function pruneSharedRuntimeState(now: number = Date.now()): Promise<PruneResult> {
  const entries = await appDb
    .delete(sharedRuntimeEntries)
    .where(lt(sharedRuntimeEntries.expiresAt, isoAt(now)))
    .returning({ key: sharedRuntimeEntries.key });
  const rateLimitCounters = await pruneRateLimitCounters(now);
  const auth = await appDb
    .delete(authRateLimits)
    .where(lt(authRateLimits.lastRequest, now - authRateLimitRetentionMs()))
    .returning({ id: authRateLimits.id });
  return { entries: entries.length, rateLimitCounters, authRateLimits: auth.length };
}

/** How often the prune job runs. */
export const PRUNE_INTERVAL_MS = 10 * 60_000;

type PruneState = { timer: ReturnType<typeof setInterval> | null; running: boolean };
const pruneStore = globalThis as typeof globalThis & { __ingressiSharedStatePrune?: PruneState };
const pruneState = (pruneStore.__ingressiSharedStatePrune ??= { timer: null, running: false });

async function pruneTick(): Promise<void> {
  if (pruneState.running) return;
  pruneState.running = true;
  try {
    await pruneSharedRuntimeState();
  } catch (error) {
    console.error("[db] Pruning expired shared runtime state failed:", error instanceof Error ? error.message : typeof error);
  } finally {
    pruneState.running = false;
  }
}

/**
 * The prune job (src/instrumentation.ts SERVER_JOBS): every PRUNE_INTERVAL_MS
 * on the node that runs background jobs. Idempotent; a missed run only
 * leaves expired rows a little longer (every read ignores them).
 */
export function startSharedRuntimeStatePrune(): void {
  if (pruneState.timer) return;
  pruneState.timer = setInterval(() => void pruneTick(), PRUNE_INTERVAL_MS);
  pruneState.timer.unref?.();
  void pruneTick();
}

export function stopSharedRuntimeStatePrune(): void {
  if (pruneState.timer) clearInterval(pruneState.timer);
  pruneState.timer = null;
}
