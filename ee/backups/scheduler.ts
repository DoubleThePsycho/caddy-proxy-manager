// SPDX-License-Identifier: Elastic-2.0
/**
 * Runs due backups every minute. Started from src/instrumentation.ts (never in
 * tests). Scheduled backups never check the license: a destination that is
 * enabled keeps backing up after the license lapses.
 */
import { markInterruptedRuns, runDueBackups } from "./runner";
import { onShutdown } from "@/src/lib/shutdown";

export const BACKUP_TICK_INTERVAL_MS = 60_000;
/** Lets the first Caddy apply and the other startup work settle. */
const FIRST_RUN_DELAY_MS = 45_000;

const store = globalThis as typeof globalThis & {
  __ingressiBackupScheduler?: { interval: ReturnType<typeof setInterval> | null };
};
const state = (store.__ingressiBackupScheduler ??= { interval: null });

async function tick(): Promise<void> {
  try {
    const result = await runDueBackups();
    if (result && result.due > 0) {
      console.log(`[backups] ${result.succeeded} backup(s) uploaded, ${result.failed} failed`);
    }
  } catch (error) {
    console.error("[backups] Scheduled backups failed:", error instanceof Error ? error.name : typeof error);
  }
}

/** The pending first run, so stopping (a PostgreSQL replica that stops leading) cancels it too. */
let firstRun: ReturnType<typeof setTimeout> | undefined;

export function startBackupScheduler(): void {
  if (state.interval) return;
  markInterruptedRuns().catch((error) =>
    console.error("[backups] Could not mark interrupted runs:", error instanceof Error ? error.name : typeof error)
  );
  clearTimeout(firstRun);
  firstRun = setTimeout(() => void tick(), FIRST_RUN_DELAY_MS);
  firstRun.unref?.();
  state.interval = setInterval(() => void tick(), BACKUP_TICK_INTERVAL_MS);
  state.interval.unref?.();
  onShutdown("stopping the backup scheduler", stopBackupScheduler);
}

export function stopBackupScheduler(): void {
  clearTimeout(firstRun);
  firstRun = undefined;
  if (state.interval) clearInterval(state.interval);
  state.interval = null;
}
