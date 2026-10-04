// SPDX-License-Identifier: Elastic-2.0
/**
 * Every minute: expires change requests past their expiry and applies
 * approved ones whose change windows are open. Started from
 * src/instrumentation.ts (never in tests). Never checks the license: approved
 * changes keep being applied after it lapses.
 */
import { applyDueChangeRequests } from "./requests";
import { onShutdown } from "@/src/lib/shutdown";

export const APPROVAL_TICK_INTERVAL_MS = 60_000;
/** Lets the first Caddy apply and the other startup work settle. */
const FIRST_RUN_DELAY_MS = 40_000;

const store = globalThis as typeof globalThis & {
  __ingressiApprovalScheduler?: { interval: ReturnType<typeof setInterval> | null; running: boolean };
};
const state = (store.__ingressiApprovalScheduler ??= { interval: null, running: false });

/** One run, skipped while the previous one is still applying. */
export async function runScheduledApprovals(): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    const result = await applyDueChangeRequests();
    if (result.applied > 0 || result.failed > 0 || result.expired > 0) {
      console.log(
        `[approvals] ${result.applied} approved change(s) applied, ${result.failed} failed, ${result.expired} request(s) expired`
      );
    }
  } catch (error) {
    console.error("[approvals] Applying approved changes failed:", error instanceof Error ? error.name : typeof error);
  } finally {
    state.running = false;
  }
}

/** The pending first run, so stopping (a PostgreSQL replica that stops leading) cancels it too. */
let firstRun: ReturnType<typeof setTimeout> | undefined;

export function startApprovalScheduler(): void {
  if (state.interval) return;
  clearTimeout(firstRun);
  firstRun = setTimeout(() => void runScheduledApprovals(), FIRST_RUN_DELAY_MS);
  firstRun.unref?.();
  state.interval = setInterval(() => void runScheduledApprovals(), APPROVAL_TICK_INTERVAL_MS);
  state.interval.unref?.();
  onShutdown("stopping the change approval scheduler", stopApprovalScheduler);
}

export function stopApprovalScheduler(): void {
  clearTimeout(firstRun);
  firstRun = undefined;
  if (state.interval) clearInterval(state.interval);
  state.interval = null;
}
