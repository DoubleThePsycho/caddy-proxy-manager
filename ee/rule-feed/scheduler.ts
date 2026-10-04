// SPDX-License-Identifier: Elastic-2.0
/**
 * The daily rule feed fetch. Started from src/instrumentation.ts (never in
 * tests); every hour it asks the gate whether this node runs it and, when a
 * subscription is due (service.ts isFetchDue), fetches and installs the feed.
 *
 * One scheduler behind one gate: today the gate lets every node that is not
 * a sync replica run it (replicas get their patches from the master). When
 * several dashboard replicas share one database (high availability, phase 2),
 * the gate becomes the leader lease, set with setRuleFeedSchedulerGate, so
 * only the leader fetches. Runtime: it never checks the license.
 */
import { patchesComeFromMaster } from "./store";
import { runScheduledRuleFeedFetch } from "./service";
import { onShutdown } from "@/src/lib/shutdown";

export const RULE_FEED_TICK_INTERVAL_MS = 60 * 60 * 1000;
/** Lets the first Caddy apply and the other startup work settle. */
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;

/** Whether this node runs the scheduled fetch now. */
export type RuleFeedSchedulerGate = () => Promise<boolean>;

const defaultGate: RuleFeedSchedulerGate = async () => !(await patchesComeFromMaster());

const store = globalThis as typeof globalThis & {
  __ingressiRuleFeedScheduler?: { interval: ReturnType<typeof setInterval> | null; gate: RuleFeedSchedulerGate; running: boolean };
};
const state = (store.__ingressiRuleFeedScheduler ??= { interval: null, gate: defaultGate, running: false });

/** Replaces the gate (high availability: the leader lease); null restores the default. */
export function setRuleFeedSchedulerGate(gate: RuleFeedSchedulerGate | null): void {
  state.gate = gate ?? defaultGate;
}

/** One scheduler tick: fetch when this node may and a subscription is due. */
export async function ruleFeedTick(now: Date = new Date()): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    if (!(await state.gate())) return;
    const result = await runScheduledRuleFeedFetch(now);
    if (result?.outcome === "updated") {
      console.log(
        `[rule-feed] Installed feed sequence ${result.sequence}: ${result.added.length} new, ${result.updated.length} updated, ${result.withdrawn.length} withdrawn`
      );
    }
  } catch (error) {
    // Recorded in the feed state (Virtual patches on the WAF page); the message is safe to log.
    console.warn("[rule-feed] Scheduled fetch failed:", error instanceof Error ? error.message : typeof error);
  } finally {
    state.running = false;
  }
}

/** The pending first run, so stopping (a PostgreSQL replica that stops leading) cancels it too. */
let firstRun: ReturnType<typeof setTimeout> | undefined;

export function startRuleFeedScheduler(): void {
  if (state.interval) return;
  clearTimeout(firstRun);
  firstRun = setTimeout(() => void ruleFeedTick(), FIRST_RUN_DELAY_MS);
  firstRun.unref?.();
  state.interval = setInterval(() => void ruleFeedTick(), RULE_FEED_TICK_INTERVAL_MS);
  state.interval.unref?.();
  onShutdown("stopping the rule feed scheduler", stopRuleFeedScheduler);
}

export function stopRuleFeedScheduler(): void {
  clearTimeout(firstRun);
  firstRun = undefined;
  if (state.interval) clearInterval(state.interval);
  state.interval = null;
}
