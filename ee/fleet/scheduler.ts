// SPDX-License-Identifier: Elastic-2.0
/**
 * Runs the fleet in the background: rollout steps every few seconds and
 * drift checks every few minutes. Started from src/instrumentation.ts (never
 * in tests).
 */
import { count } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { fleetEnvironments } from "@/src/lib/db/schema";
import { runDriftChecks } from "./drift";
import { runRolloutTick, setRolloutKick } from "./rollouts";
import { onShutdown } from "@/src/lib/shutdown";

export const ROLLOUT_TICK_INTERVAL_MS = 10_000;
export const DRIFT_CHECK_INTERVAL_MS = 5 * 60_000;
/** Lets Caddy and the first config apply and sync settle after a restart. */
const FIRST_RUN_DELAY_MS = 30_000;

const store = globalThis as typeof globalThis & {
  __ingressiFleetScheduler?: {
    rollouts: ReturnType<typeof setInterval> | null;
    drift: ReturnType<typeof setInterval> | null;
    driftRunning: boolean;
  };
};
const state = (store.__ingressiFleetScheduler ??= { rollouts: null, drift: null, driftRunning: false });

async function rolloutTick(): Promise<void> {
  try {
    await runRolloutTick();
  } catch (error) {
    console.error("[fleet] Rollout step failed:", error instanceof Error ? error.name : typeof error);
  }
}

/** Drift checks run once at least one environment exists (fleet management is set up). */
async function driftTick(): Promise<void> {
  if (state.driftRunning) return;
  state.driftRunning = true;
  try {
    const [row] = await appDb.select({ value: count() }).from(fleetEnvironments);
    if ((row?.value ?? 0) > 0) await runDriftChecks();
  } catch (error) {
    console.error("[fleet] Drift check failed:", error instanceof Error ? error.name : typeof error);
  } finally {
    state.driftRunning = false;
  }
}

/** The pending first run, so stopping (a PostgreSQL replica that stops leading) cancels it too. */
let firstRun: ReturnType<typeof setTimeout> | undefined;

export function startFleetScheduler(): void {
  if (state.rollouts) return;
  setRolloutKick(() => {
    setTimeout(() => void rolloutTick(), 0).unref?.();
  });
  clearTimeout(firstRun);
  firstRun = setTimeout(() => {
    void rolloutTick();
    void driftTick();
  }, FIRST_RUN_DELAY_MS);
  firstRun.unref?.();
  state.rollouts = setInterval(() => void rolloutTick(), ROLLOUT_TICK_INTERVAL_MS);
  state.rollouts.unref?.();
  state.drift = setInterval(() => void driftTick(), DRIFT_CHECK_INTERVAL_MS);
  state.drift.unref?.();
  onShutdown("stopping the fleet scheduler", stopFleetScheduler);
}

export function stopFleetScheduler(): void {
  clearTimeout(firstRun);
  firstRun = undefined;
  if (state.rollouts) clearInterval(state.rollouts);
  if (state.drift) clearInterval(state.drift);
  state.rollouts = null;
  state.drift = null;
  setRolloutKick(null);
}
