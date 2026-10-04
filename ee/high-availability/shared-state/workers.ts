// SPDX-License-Identifier: Elastic-2.0
/**
 * Background work of the shared state, in two parts. Each tick does nothing
 * while shared state is off.
 *
 *  - startSharedStateNodeWorker, on EVERY web node, standbys included (it
 *    never writes to the database): reports the API consumers this node
 *    charged to the shared dirty set; reloads the gate's copy of the
 *    configuration when another node announces a change (again for ten
 *    seconds, as a standby's database trails the leader's, and every 30
 *    seconds in any case); announces this node's administrators' changes.
 *  - startSharedStateDrain, on the LEADER only (a background job): writes
 *    shared usage and credits back to the ledger every five seconds (every
 *    consumer once a minute), seeds every consumer's balance once a minute
 *    while sync replicas charge them (they never seed), and removes expired
 *    forward-auth sessions from the shared listing once a minute. It also checks isSharedStateLeader()
 *    and takes a lock in the shared state, and the write-back is idempotent,
 *    so a second drainer can do no harm.
 */
import { onMonetizationIndexChanged, reloadMonetization } from "@/ee/monetization/engine";
import { getSharedState, type SharedState } from "./connection";
import { createRedisForwardAuthStore } from "./forward-auth-store";
import { isSharedStateLeader } from "./leader";
import { drainSharedMonetization, reportTouchedConsumers } from "./monetization-drain";
import { monetizationKeyNames } from "./monetization-keys";
import { publishMonetizationChange, seedSharedConsumers, takeTouchedConsumers } from "./monetization-store";

const NODE_TICK_MS = 1_000;
const REPORT_EVERY_MS = 2_000;
const VERSION_POLL_MS = 2_000;
const RELOAD_EVERY_MS = 30_000;
const RELOAD_AFTER_CHANGE_MS = 10_000;
export const DRAIN_EVERY_MS = 5_000;
const FULL_DRAIN_EVERY_MS = 60_000;
const CLEANUP_EVERY_MS = 60_000;

type Loop = { timer: ReturnType<typeof setInterval> | null; running: boolean };

type Workers = {
  node: Loop;
  drain: Loop;
  last: { report: number; poll: number; reload: number; fullDrain: number; cleanup: number };
  /** The announced version last seen; undefined before the first poll (null: none announced yet). */
  version: string | null | undefined;
  /** After a change another node announced, reload on every poll until then. */
  reloadUntil: number;
  unsubscribe: (() => void) | null;
};

const store = globalThis as typeof globalThis & { __ingressiSharedStateWorkers?: Workers };
function workers(): Workers {
  return (store.__ingressiSharedStateWorkers ??= {
    node: { timer: null, running: false },
    drain: { timer: null, running: false },
    last: { report: 0, poll: 0, reload: 0, fullDrain: 0, cleanup: 0 },
    version: undefined,
    reloadUntil: 0,
    unsubscribe: null,
  });
}

function logFailure(what: string, error: unknown): void {
  console.error(`[shared-state] ${what} failed:`, error instanceof Error ? error.name : typeof error);
}

async function currentState(): Promise<SharedState | null> {
  try {
    return await getSharedState();
  } catch {
    // Misconfigured: request paths fail closed and the status card says why.
    return null;
  }
}

/** One round of the every-node work; exported for tests. Never writes to the database. */
export async function runSharedStateNodeTick(now: number = Date.now()): Promise<void> {
  const w = workers();
  const state = await currentState();
  if (!state) {
    w.version = undefined;
    return;
  }
  if (now - w.last.report >= REPORT_EVERY_MS) {
    w.last.report = now;
    await reportTouchedConsumers(state, takeTouchedConsumers()).catch((error: unknown) => logFailure("Reporting charged consumers", error));
  }
  if (now - w.last.poll >= VERSION_POLL_MS) {
    w.last.poll = now;
    try {
      const version = await state.redis.get(monetizationKeyNames(state.namespace).version);
      if (w.version !== undefined && version !== w.version) w.reloadUntil = now + RELOAD_AFTER_CHANGE_MS;
      w.version = version;
      if (now < w.reloadUntil || now - w.last.reload >= RELOAD_EVERY_MS) {
        w.last.reload = now;
        await reloadMonetization({ quiet: true });
      }
    } catch (error) {
      logFailure("Checking for gate changes", error);
    }
  }
}

/** One round of the leader's work; exported for tests. */
export async function runSharedStateDrainTick(now: number = Date.now()): Promise<void> {
  const w = workers();
  const state = await currentState();
  if (!state || !(await isSharedStateLeader())) return;
  const all = now - w.last.fullDrain >= FULL_DRAIN_EVERY_MS;
  try {
    const result = await drainSharedMonetization(state, { all });
    if (all && result.ran) w.last.fullDrain = now;
  } catch (error) {
    logFailure("Writing shared usage to the ledger", error);
  }
  // Sync replicas charging these balances never seed a consumer: the leader does, once a minute.
  if (all) {
    try {
      const { getMonetizationOptions } = await import("@/ee/monetization/options");
      if ((await getMonetizationOptions()).replicaMode === "shared") {
        const { appDb } = await import("@/src/lib/db");
        const { monetizationConsumers } = await import("@/src/lib/db/schema");
        const ids = (await appDb.select({ id: monetizationConsumers.id }).from(monetizationConsumers)).map((row) => row.id);
        await seedSharedConsumers(state, ids);
      }
    } catch (error) {
      logFailure("Seeding shared balances for sync replicas", error);
    }
  }
  if (now - w.last.cleanup >= CLEANUP_EVERY_MS) {
    w.last.cleanup = now;
    await createRedisForwardAuthStore(state)
      .cleanupExpired()
      .catch((error: unknown) => logFailure("Removing expired forward-auth sessions", error));
  }
}

function startLoop(loop: Loop, intervalMs: number, tick: () => Promise<void>): void {
  if (loop.timer) return;
  loop.timer = setInterval(() => {
    if (loop.running) return;
    loop.running = true;
    void tick().finally(() => {
      loop.running = false;
    });
  }, intervalMs);
  loop.timer.unref?.();
}

/**
 * Every web node, standbys included (idempotent): reports charges, keeps the
 * gate's configuration current, announces local changes. Writes nothing to
 * the database.
 */
export function startSharedStateNodeWorker(): void {
  const w = workers();
  if (!w.unsubscribe) {
    w.unsubscribe = onMonetizationIndexChanged(() => {
      void currentState()
        .then((state) => (state ? publishMonetizationChange(state) : undefined))
        .catch((error: unknown) => logFailure("Announcing a gate change", error));
    });
  }
  startLoop(w.node, NODE_TICK_MS, () => runSharedStateNodeTick());
}

/** The leader's background job (idempotent): writes shared balances back to the ledger. */
export function startSharedStateDrain(): void {
  startLoop(workers().drain, DRAIN_EVERY_MS, () => runSharedStateDrainTick());
}

/** Stops the leader's write-back (a PostgreSQL replica that stops leading); the node worker keeps running. */
export function stopSharedStateDrain(): void {
  const loop = workers().drain;
  if (loop.timer) clearInterval(loop.timer);
  loop.timer = null;
}

export function stopSharedStateWorkers(): void {
  const w = workers();
  for (const loop of [w.node, w.drain]) {
    if (loop.timer) clearInterval(loop.timer);
    loop.timer = null;
  }
  w.unsubscribe?.();
  w.unsubscribe = null;
}

/** Tests only: forget timers and the last runs. */
export function resetSharedStateWorkersForTests(): void {
  stopSharedStateWorkers();
  store.__ingressiSharedStateWorkers = undefined;
}
