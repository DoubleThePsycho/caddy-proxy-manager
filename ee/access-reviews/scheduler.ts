// SPDX-License-Identifier: Elastic-2.0
/**
 * Starts due access review campaigns every few minutes. Started from
 * src/instrumentation.ts (never in tests). Scheduled reviews never check the
 * license: a schedule that was set up keeps starting campaigns after the
 * license lapses.
 */
import { runDueSchedules } from "./schedules";
import { onShutdown } from "@/src/lib/shutdown";

export const ACCESS_REVIEW_TICK_INTERVAL_MS = 5 * 60_000;
/** Lets the other startup work settle. */
const FIRST_RUN_DELAY_MS = 60_000;

const store = globalThis as typeof globalThis & {
  __ingressiAccessReviewScheduler?: { interval: ReturnType<typeof setInterval> | null };
};
const state = (store.__ingressiAccessReviewScheduler ??= { interval: null });

/** Never rejects: a failure is logged and the next tick tries again. */
async function tick(): Promise<void> {
  try {
    const result = await runDueSchedules();
    if (result.started > 0 || result.failed > 0) {
      console.log(`[access-reviews] ${result.started} scheduled review(s) started, ${result.failed} could not start`);
    }
  } catch (error) {
    console.error("[access-reviews] Scheduled reviews failed:", error instanceof Error ? error.name : typeof error);
  }
}

/** The pending first run, so stopping (a PostgreSQL replica that stops leading) cancels it too. */
let firstRun: ReturnType<typeof setTimeout> | undefined;

export function startAccessReviewScheduler(): void {
  if (state.interval) return;
  clearTimeout(firstRun);
  firstRun = setTimeout(() => void tick(), FIRST_RUN_DELAY_MS);
  firstRun.unref?.();
  state.interval = setInterval(() => void tick(), ACCESS_REVIEW_TICK_INTERVAL_MS);
  state.interval.unref?.();
  onShutdown("stopping the access review scheduler", stopAccessReviewScheduler);
}

export function stopAccessReviewScheduler(): void {
  clearTimeout(firstRun);
  firstRun = undefined;
  if (state.interval) clearInterval(state.interval);
  state.interval = null;
}
