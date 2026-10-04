// SPDX-License-Identifier: Elastic-2.0
/**
 * Checks every minute whether the daily digest is due and sends it. Started
 * from src/instrumentation.ts (never in tests). Never checks the license.
 */
import { runScheduledDigest } from "./digest";
import { onShutdown } from "@/src/lib/shutdown";

export const DIGEST_CHECK_INTERVAL_MS = 60_000;

const store = globalThis as typeof globalThis & {
  __ingressiDigestScheduler?: { interval: ReturnType<typeof setInterval> | null; running: boolean };
};
const state = (store.__ingressiDigestScheduler ??= { interval: null, running: false });

/** One check, skipped while the previous digest is still being sent. */
export async function runDigestCheck(now: Date = new Date()): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    const outcome = await runScheduledDigest(now);
    if (outcome === "sent") console.log("[ai-digest] Daily security digest sent");
    else if (outcome === "no_channels") console.warn("[ai-digest] The daily security digest has no enabled channel");
  } catch (error) {
    console.error("[ai-digest] The daily security digest failed:", error instanceof Error ? error.name : typeof error);
  } finally {
    state.running = false;
  }
}

export function startDigestScheduler(): void {
  if (state.interval) return;
  state.interval = setInterval(() => void runDigestCheck(), DIGEST_CHECK_INTERVAL_MS);
  state.interval.unref?.();
  onShutdown("stopping the daily digest scheduler", stopDigestScheduler);
}

export function stopDigestScheduler(): void {
  if (state.interval) clearInterval(state.interval);
  state.interval = null;
}
