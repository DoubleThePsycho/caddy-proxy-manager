/**
 * What the SQLite and PostgreSQL executors (executor.ts, pg-executor.ts)
 * share: the ambient transaction context, the frames of open transactions
 * and savepoints, the FIFO lock, escaped-query detection and the watchdog.
 * Nothing here talks to a database.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { AppTx } from "./types";

// ── Errors ──

/** A query or transaction that ran after the transaction it was started in had finished. */
export class TransactionEscapeError extends Error {
  constructor() {
    super(
      "A database query ran after its transaction had finished: a promise started inside db.transaction() " +
        "was not awaited. Await every query in the transaction callback, or start deliberate background " +
        "work with outsideTransaction()."
    );
    this.name = "TransactionEscapeError";
  }
}

/** Escaped queries throw outside production; in production they run on their own. */
export function escapesThrow(): boolean {
  return process.env.NODE_ENV !== "production";
}

// ── FIFO lock ──

/** A first-in, first-out lock: release() hands it to the longest waiter. */
export class FifoLock {
  private locked = false;
  private readonly waiters: Array<() => void> = [];

  /** Takes the lock if nobody holds or waits for it. */
  tryAcquire(): boolean {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }

  acquire(): Promise<void> {
    if (this.tryAcquire()) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.locked = false;
  }

  get idle(): boolean {
    return !this.locked;
  }

  get waiting(): number {
    return this.waiters.length;
  }
}

// ── Transaction context ──

/** The outermost transaction of a chain of frames. */
export interface TransactionRoot {
  /** The executor the transaction runs on (compared by identity). */
  readonly executor: object;
  readonly readOnly: boolean;
  closed: boolean;
  savepoints: number;
}

/** One open transaction or savepoint (opaque outside the executors). */
export interface TransactionFrame {
  readonly root: TransactionRoot;
  readonly parent: TransactionFrame | null;
  readonly depth: number;
  closed: boolean;
  /** Savepoints opened directly in this frame run one at a time. */
  readonly children: FifoLock;
  tx: AppTx;
}

/** Which executor (and, for a transaction object, which transaction) a db or tx object belongs to. */
export interface TargetEntry {
  executor: object;
  /** The transaction a tx object is bound to; null for a database facade. */
  frame: TransactionFrame | null;
}

type GlobalDbState = typeof globalThis & {
  __ingressiDbTransactionContext?: AsyncLocalStorage<TransactionFrame>;
  __ingressiDbTargets?: WeakMap<object, TargetEntry>;
  __ingressiDbWatchdogMs?: number | null;
};

const globalState = globalThis as GlobalDbState;

// Shared across module reloads (development) so a reloaded module still sees
// the transactions the previous copy opened.
export const transactionContext = (globalState.__ingressiDbTransactionContext ??= new AsyncLocalStorage<TransactionFrame>());
/** Which executor (and, for a transaction object, which transaction) a db or tx object belongs to. */
export const targets = (globalState.__ingressiDbTargets ??= new WeakMap<object, TargetEntry>());

/** The innermost transaction of `frame`'s chain that is still open, or null when its transaction finished. */
export function openFrame(frame: TransactionFrame): TransactionFrame | null {
  if (frame.root.closed) return null;
  let current: TransactionFrame = frame;
  while (current.closed && current.parent) current = current.parent;
  return current;
}

/** The open transaction frame of the calling async context on `executor`, if any. */
export function ambientFrameOf(executor: object): TransactionFrame | null {
  const frame = transactionContext.getStore();
  return frame && frame.root.executor === executor ? frame : null;
}

/** Whether the calling async context is inside an open transaction (of any database). */
export function inTransaction(): boolean {
  const frame = transactionContext.getStore();
  return !!frame && openFrame(frame) !== null;
}

/**
 * Runs `fn` outside the calling context's transaction: its queries wait for
 * the gate instead of joining. For deliberate background work started from
 * inside a transaction (a timer, a queue flush) that must not escape it.
 */
export function outsideTransaction<T>(fn: () => T): T {
  return transactionContext.exit(fn);
}

// ── Watchdog ──

const DEFAULT_WATCHDOG_MS = 250;

function watchdogMs(): number | null {
  if (globalState.__ingressiDbWatchdogMs !== undefined) return globalState.__ingressiDbWatchdogMs;
  return process.env.NODE_ENV === "development" ? DEFAULT_WATCHDOG_MS : null;
}

/**
 * Sets how long a transaction may hold the gate before a warning is logged
 * (null turns the watchdog off). Without a call it is 250 ms in development
 * and off elsewhere.
 */
export function setTransactionWatchdog(ms: number | null): void {
  globalState.__ingressiDbWatchdogMs = ms;
}

/** Starts timing a transaction; the returned function stops the timer and logs one that held on too long. */
export function startWatchdog(): () => void {
  const limit = watchdogMs();
  if (limit === null) return () => {};
  const origin = new Error("Transaction started").stack?.split("\n").slice(2, 8).join("\n") ?? "";
  const startedAt = performance.now();
  let warned = false;
  const warn = (heldMs: number, stillOpen: boolean) => {
    warned = true;
    console.warn(
      `[db] A transaction ${stillOpen ? "has held" : "held"} the database for ${Math.round(heldMs)} ms ` +
        `(more than ${limit} ms) while other queries waited; keep transactions to database work.\n${origin}`
    );
  };
  const timer = setTimeout(() => warn(performance.now() - startedAt, true), limit);
  (timer as { unref?: () => void }).unref?.();
  return () => {
    clearTimeout(timer);
    const held = performance.now() - startedAt;
    if (!warned && held > limit) warn(held, false);
  };
}

/** The BEGIN modes `transaction(fn, { behavior })` accepts. */
export const TRANSACTION_BEHAVIORS = ["deferred", "immediate", "exclusive"] as const;

export function assertTransactionBehavior(behavior: string): void {
  if (!(TRANSACTION_BEHAVIORS as readonly string[]).includes(behavior)) {
    throw new Error(`Unknown transaction behavior ${JSON.stringify(behavior)}`);
  }
}
