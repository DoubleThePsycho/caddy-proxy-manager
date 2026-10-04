// SPDX-License-Identifier: Elastic-2.0
/**
 * One backup at a time per destination, in the whole deployment. Scheduled
 * runs and "Back up now" take the destination's cluster lock
 * (src/lib/db/locks.ts) without waiting for it, so a destination never has
 * two runs at once, whichever replica starts them.
 *
 * Whether a destination is running is read from its runs (a run is
 * "running" from its start to its end), so every replica shows the same,
 * and from this process's locks (a run that has taken the lock but not yet
 * stored its row). A run left "running" by a process that stopped is marked
 * interrupted by the scheduler once its destination's lock is free
 * (runner.ts markInterruptedRuns).
 */
import { and, eq, inArray } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { backupRuns } from "@/src/lib/db/schema";
import { isClusterLockHeld, tryWithClusterLock, type TryLockResult } from "@/src/lib/db/locks";

/** The cluster lock of a destination's backups. */
export function destinationLockName(id: number): string {
  return `backup-destination:${id}`;
}

/** Runs `fn` holding the destination's lock, unless a backup to it is running (then `{ acquired: false }`). */
export async function tryWithDestinationLock<T>(id: number, fn: () => Promise<T>): Promise<TryLockResult<T>> {
  return await tryWithClusterLock(destinationLockName(id), fn);
}

/** Of `ids`, the destinations with a backup in progress. */
export async function runningDestinationIds(ids: readonly number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await appDb
    .selectDistinct({ destinationId: backupRuns.destinationId })
    .from(backupRuns)
    .where(and(eq(backupRuns.status, "running"), inArray(backupRuns.destinationId, [...ids])));
  const running = new Set(rows.map((row) => row.destinationId));
  for (const id of ids) {
    if (isClusterLockHeld(destinationLockName(id))) running.add(id);
  }
  return running;
}

/** Whether a backup to the destination is in progress. */
export async function isDestinationRunning(id: number): Promise<boolean> {
  return (await runningDestinationIds([id])).has(id);
}
