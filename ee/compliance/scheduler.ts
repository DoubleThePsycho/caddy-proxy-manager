// SPDX-License-Identifier: Elastic-2.0
/**
 * Runs due report schedules every few minutes. Started from
 * src/instrumentation.ts (never in tests).
 */
import { runDueReportSchedules } from "./schedules";
import { onShutdown } from "@/src/lib/shutdown";

export const REPORT_SCHEDULE_TICK_INTERVAL_MS = 5 * 60_000;
/** Lets the other startup work settle. */
const FIRST_RUN_DELAY_MS = 90_000;

const store = globalThis as typeof globalThis & {
  __ingressiReportScheduler?: { interval: ReturnType<typeof setInterval> | null; running: boolean };
};
const state = (store.__ingressiReportScheduler ??= { interval: null, running: false });

async function tick(): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    const ran = await runDueReportSchedules();
    if (ran > 0) console.log(`[compliance] ${ran} scheduled evidence report run(s) done`);
  } catch (error) {
    console.error("[compliance] Scheduled reports failed:", error instanceof Error ? error.name : typeof error);
  } finally {
    state.running = false;
  }
}

/** The pending first run, so stopping (a PostgreSQL replica that stops leading) cancels it too. */
let firstRun: ReturnType<typeof setTimeout> | undefined;

export function startReportScheduler(): void {
  if (state.interval) return;
  clearTimeout(firstRun);
  firstRun = setTimeout(() => void tick(), FIRST_RUN_DELAY_MS);
  firstRun.unref?.();
  state.interval = setInterval(() => void tick(), REPORT_SCHEDULE_TICK_INTERVAL_MS);
  state.interval.unref?.();
  onShutdown("stopping the compliance report scheduler", stopReportScheduler);
}

export function stopReportScheduler(): void {
  clearTimeout(firstRun);
  firstRun = undefined;
  if (state.interval) clearInterval(state.interval);
  state.interval = null;
}
