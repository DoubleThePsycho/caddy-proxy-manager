/**
 * Values that requests read synchronously but that are stored in the
 * database and change rarely: the white-label branding and the sign-in
 * providers Better Auth is built with (src/lib/db/README.md, "Cached
 * values").
 *
 * - `register()` in src/instrumentation.ts loads every defined value once
 *   (loadCachedValues), after runDatabaseStartup().
 * - `current()` is synchronous, never touches the database and never throws. It
 *   returns the loaded value; before the first load it returns the fallback
 *   and starts a load. A value older than its TTL is still returned while a
 *   refresh runs in the background: the TTL is a safety net for changes this
 *   process did not make (a high availability standby's replicated copy, a
 *   row edited by hand).
 * - The code that changes what a value is loaded from awaits `changed()`,
 *   which reads it again at once. In a transaction it reads the transaction's
 *   own writes, and reads again once the transaction has ended, so a rollback
 *   does not leave the uncommitted value behind.
 * - Each value lives on globalThis under its name, so every module instance
 *   Next.js creates shares it.
 * - With several replicas (PostgreSQL), `changed()` also publishes the
 *   value's name on the invalidation bus (src/lib/db/events.ts, channel
 *   "cached-value"; inside a transaction the message goes out when it
 *   commits), and every other replica reads the value again. When a
 *   replica's listening connection was lost it reads every loaded value
 *   again (a resync).
 */
import { subscribe, publish, type BusEvent } from "./events";
import { inTransaction, outsideTransaction } from "./executor";
import { afterTransactionEnds } from "./executor-core";

export interface CachedValueOptions<T> {
  /**
   * Reads the value from the database. On a background refresh `current` is
   * the loaded value, to skip work when nothing changed; it is undefined when
   * the value must be read in full (start-up, refresh(), changed()).
   */
  load: (current: T | undefined) => Promise<T>;
  /** What `current()` returns before the first successful load. */
  fallback: T;
  /** How old a loaded value may get before `current()` refreshes it in the background (default 30 s). */
  ttlMs?: number;
  /** How long to wait after a failed load before `current()` tries again (default 5 s). */
  retryMs?: number;
  /**
   * Whether a newly loaded value is the same as the current one; the current
   * object is then kept, so readers can compare values by identity.
   */
  isUnchanged?: (current: T, next: T) => boolean;
}

export interface CachedValue<T> {
  readonly name: string;
  /** The value in memory: synchronous, never throws. */
  current(): T;
  /** Whether a load has succeeded. */
  isLoaded(): boolean;
  /** Reads the value from the database now; throws when it cannot be read. */
  refresh(): Promise<T>;
  /**
   * Call after changing what the value is loaded from: reads it again now
   * (and, with several replicas, there as well). Never throws: a failed read
   * is logged and retried by the next `current()`.
   */
  changed(): Promise<T>;
  /** Forgets the loaded value (tests): the next `current()` returns the fallback and loads. */
  reset(): void;
}

interface Slot {
  options: CachedValueOptions<unknown>;
  value: unknown;
  loaded: boolean;
  loadedAt: number;
  failedAt: number;
  /** Loads started and the latest one whose result was kept: a slow, older load never overwrites a newer one. */
  started: number;
  applied: number;
  background: Promise<unknown> | null;
  /** Another background refresh was asked for while one ran: run it after. */
  again: boolean;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_RETRY_MS = 5_000;

const shared = globalThis as typeof globalThis & { __ingressiCachedValues?: Map<string, Slot> };
const slots = (shared.__ingressiCachedValues ??= new Map<string, Slot>());

function slotOf(name: string): Slot {
  const slot = slots.get(name);
  if (!slot) throw new Error(`Unknown cached value ${JSON.stringify(name)}`);
  return slot;
}

async function load(name: string, slot: Slot, background = false): Promise<unknown> {
  const sequence = ++slot.started;
  let next: unknown;
  try {
    next = await slot.options.load(background && slot.loaded ? slot.value : undefined);
  } catch (error) {
    slot.failedAt = Date.now();
    throw error;
  }
  if (sequence > slot.applied) {
    slot.applied = sequence;
    const unchanged = slot.loaded && slot.options.isUnchanged?.(slot.value, next) === true;
    if (!unchanged) slot.value = next;
    slot.loaded = true;
    slot.loadedAt = Date.now();
  }
  // Read inside a transaction: read again once it has ended (committed or
  // rolled back), from outside it. Not before: on PostgreSQL a read outside
  // the transaction does not wait for it, and would put the old value back.
  if (inTransaction()) afterTransactionEnds(() => refreshInBackground(name, slot));
  return slot.value;
}

/** Starts a refresh that does not join the caller's transaction; one at a time per value. */
function refreshInBackground(name: string, slot: Slot): void {
  if (slot.background) {
    // It may have read before the change that asks for this one.
    slot.again = true;
    return;
  }
  slot.background = outsideTransaction(() =>
    load(name, slot, true)
      .catch((error: unknown) => {
        console.warn(`[db] Could not refresh the cached ${name}:`, error instanceof Error ? error.message : error);
      })
      .finally(() => {
        slot.background = null;
        if (slot.again) {
          slot.again = false;
          refreshInBackground(name, slot);
        }
      })
  );
}

/** The bus channel cached values are announced on (the payload is the name). */
export const CACHED_VALUE_CHANNEL = "cached-value";

/**
 * Tells the other replicas that `name` changed: they read it again
 * (onCachedValueEvent). Never throws.
 */
async function announceChange(name: string): Promise<void> {
  try {
    await publish(CACHED_VALUE_CHANNEL, name);
  } catch (error) {
    console.warn(`[db] Could not announce a change of the cached ${name}:`, error instanceof Error ? error.message : error);
  }
}

/**
 * What another replica's announcement does here: read the named value
 * again; after a resync, every value loaded so far. This process's own
 * announcements are skipped (changed() has read the value already).
 */
async function onCachedValueEvent(event: BusEvent): Promise<void> {
  if (event.kind === "message") {
    if (event.self || !event.payload) return;
    const slot = slots.get(event.payload);
    if (!slot) return;
    await reloadFromEvent(event.payload, slot);
    return;
  }
  for (const [name, slot] of slots) {
    if (slot.loaded) await reloadFromEvent(name, slot);
  }
}

async function reloadFromEvent(name: string, slot: Slot): Promise<void> {
  try {
    await load(name, slot);
  } catch (error) {
    // The next current() reads it again.
    slot.loadedAt = 0;
    console.warn(`[db] Could not reload the cached ${name} after a change elsewhere:`, error instanceof Error ? error.message : error);
  }
}

// One subscription per process, whichever copy of this module loads first.
const busState = globalThis as typeof globalThis & { __ingressiCachedValueBus?: boolean };
if (!busState.__ingressiCachedValueBus) {
  busState.__ingressiCachedValueBus = true;
  subscribe(CACHED_VALUE_CHANNEL, (event) => onCachedValueEvent(event));
}

/**
 * Defines (or, on a module reload, redefines) the cached value `name`. The
 * value itself is kept across redefinitions.
 */
export function defineCachedValue<T>(name: string, options: CachedValueOptions<T>): CachedValue<T> {
  const existing = slots.get(name);
  if (existing) {
    existing.options = options as CachedValueOptions<unknown>;
  } else {
    slots.set(name, {
      options: options as CachedValueOptions<unknown>,
      value: options.fallback,
      loaded: false,
      loadedAt: 0,
      failedAt: 0,
      started: 0,
      applied: 0,
      background: null,
      again: false,
    });
  }
  return {
    name,
    current() {
      const slot = slotOf(name);
      const now = Date.now();
      if (!slot.loaded) {
        if (now - slot.failedAt >= (slot.options.retryMs ?? DEFAULT_RETRY_MS)) refreshInBackground(name, slot);
        return slot.options.fallback as T;
      }
      if (now - slot.loadedAt >= (slot.options.ttlMs ?? DEFAULT_TTL_MS)) refreshInBackground(name, slot);
      return slot.value as T;
    },
    isLoaded() {
      return slotOf(name).loaded;
    },
    async refresh() {
      return (await load(name, slotOf(name))) as T;
    },
    async changed() {
      const slot = slotOf(name);
      await announceChange(name);
      try {
        return (await load(name, slot)) as T;
      } catch (error) {
        // The next current() reads it again.
        slot.loadedAt = 0;
        console.warn(`[db] Could not reload the cached ${name}:`, error instanceof Error ? error.message : error);
        return (slot.loaded ? slot.value : slot.options.fallback) as T;
      }
    },
    reset() {
      const slot = slotOf(name);
      slot.value = slot.options.fallback;
      slot.loaded = false;
      slot.loadedAt = 0;
      slot.failedAt = 0;
      slot.applied = slot.started;
    },
  };
}

/**
 * Reads cached value `name` again, if this process defined it (the receiving
 * end of announceChange on another replica). Whether it is defined here.
 */
export async function refreshCachedValue(name: string): Promise<boolean> {
  const slot = slots.get(name);
  if (!slot) return false;
  await load(name, slot);
  return true;
}

/**
 * Loads every cached value the process has defined (start-up). A value that
 * cannot be read is logged and keeps its fallback; `current()` tries again.
 */
export async function loadCachedValues(): Promise<void> {
  for (const [name, slot] of slots) {
    try {
      await load(name, slot);
    } catch (error) {
      console.warn(`[db] Could not load the cached ${name}:`, error instanceof Error ? error.message : error);
    }
  }
}

/** Resolves once no background refresh is running (tests). */
export async function cachedValuesSettled(): Promise<void> {
  for (;;) {
    const running = [...slots.values()].map((slot) => slot.background).filter((refresh) => refresh !== null);
    if (running.length === 0) return;
    await Promise.all(running);
  }
}
