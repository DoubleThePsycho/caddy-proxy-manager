// SPDX-License-Identifier: Elastic-2.0
/**
 * The leader's API monetization jobs (started from src/instrumentation.ts):
 *
 *  - postpaid billing every minute (postpaid.ts: threshold, end-of-period
 *    and card-expiry charges), and ending the "billing_switch" suspension of
 *    a billing switch that stopped half way;
 *  - reconciling charges whose outcome is not known, 30 seconds after start
 *    (a charge sent before a crash) and every five minutes;
 *  - pruning usage history older than the retention, a few minutes after
 *    start and then daily (retention.ts);
 *  - x402 payments, every minute (x402/gate.ts reconcileX402Payments): a
 *    claimed nonce never verified released, a settlement whose outcome never
 *    came back kept as unknown, a settled payment Stripe has not confirmed
 *    yet recorded again (same idempotency key).
 *
 * Each pass takes its own cluster lock, so a second leader does no harm.
 * Returns the function that stops them.
 */
import { clearStaleSwitchSuspensions, reconcilePendingCharges, runPostpaidBilling } from "./postpaid";
import { pruneMonetizationHistory } from "./retention";
import { reconcileX402Payments } from "./x402/gate";

const BILLING_EVERY_MS = 60_000;
const RECONCILE_FIRST_MS = 30_000;
const RECONCILE_EVERY_MS = 5 * 60_000;
const RETENTION_FIRST_MS = 5 * 60_000;
const RETENTION_EVERY_MS = 24 * 60 * 60_000;
const X402_EVERY_MS = 60_000;

function logFailure(what: string, error: unknown): void {
  console.error(`[monetization] ${what} failed:`, error instanceof Error ? error.name : typeof error);
}

/** A timer whose runs never overlap and never throw. */
function every(intervalMs: number, firstMs: number, run: () => Promise<unknown>, what: string): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void run()
      .catch((error: unknown) => logFailure(what, error))
      .finally(() => {
        running = false;
      });
  };
  const first = setTimeout(tick, firstMs);
  const timer = setInterval(tick, intervalMs);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

export function startMonetizationJobs(): () => void {
  const stops = [
    every(BILLING_EVERY_MS, BILLING_EVERY_MS, () => runPostpaidBilling(), "Postpaid billing"),
    every(BILLING_EVERY_MS, BILLING_EVERY_MS, () => clearStaleSwitchSuspensions(), "Ending stopped billing switches"),
    every(RECONCILE_EVERY_MS, RECONCILE_FIRST_MS, () => reconcilePendingCharges(), "Reconciling charges"),
    every(RETENTION_EVERY_MS, RETENTION_FIRST_MS, () => pruneMonetizationHistory(), "Pruning usage history"),
    every(X402_EVERY_MS, X402_EVERY_MS, () => reconcileX402Payments(), "Reconciling x402 payments"),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
