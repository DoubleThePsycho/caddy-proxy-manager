/**
 * Expiring access list rules (a blocked source added for a day, or any rule
 * with expiresAt). The Caddy configuration always leaves expired rules out;
 * this job makes the change take effect when the expiry passes.
 *
 * Every minute, on a master or standalone instance, rules whose expiry has
 * passed are deleted, audited and the configuration applied (which syncs
 * slaves). On a sync slave nothing is deleted (the master owns the data and
 * syncs the deletion); Caddy is applied again once for each rule that
 * expired, so it stops applying even while the master is unreachable.
 * Started from src/instrumentation.ts (never in tests).
 */
import { applyCaddyConfig } from "./caddy";
import { getInstanceMode } from "./instance-sync";
import { deleteExpiredAccessListRules, listExpiredAccessListRules } from "./models/access-lists";
import { onShutdown } from "./shutdown";

export const ACCESS_LIST_EXPIRY_INTERVAL_MS = 60_000;
/** Lets the first Caddy apply settle. */
const FIRST_RUN_DELAY_MS = 30_000;

type ExpiryState = {
  interval: ReturnType<typeof setInterval> | null;
  running: boolean;
  /** On a slave: expired rules Caddy was already applied without. */
  appliedOnSlave: Set<number>;
};

const store = globalThis as typeof globalThis & { __ingressiAccessListExpiry?: ExpiryState };
const state = (store.__ingressiAccessListExpiry ??= { interval: null, running: false, appliedOnSlave: new Set() });

/** One run; returns what it did. */
export async function runAccessListExpiry(now: Date = new Date()): Promise<{ deleted: number; reapplied: boolean }> {
  if ((await getInstanceMode()) === "slave") {
    const expired = await listExpiredAccessListRules(now);
    const ids = new Set(expired.map((rule) => rule.id));
    for (const id of state.appliedOnSlave) if (!ids.has(id)) state.appliedOnSlave.delete(id);
    const fresh = expired.filter((rule) => !state.appliedOnSlave.has(rule.id));
    if (fresh.length === 0) return { deleted: 0, reapplied: false };
    await applyCaddyConfig();
    for (const rule of fresh) state.appliedOnSlave.add(rule.id);
    return { deleted: 0, reapplied: true };
  }
  return { deleted: await deleteExpiredAccessListRules(now), reapplied: false };
}

async function tick(): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    const result = await runAccessListExpiry();
    if (result.deleted > 0) console.log(`[access-lists] ${result.deleted} expired rule(s) removed`);
  } catch (error) {
    console.error("[access-lists] Removing expired rules failed:", error instanceof Error ? error.name : typeof error);
  } finally {
    state.running = false;
  }
}

/** The pending first run, so stopping (a PostgreSQL replica that stops leading) cancels it too. */
let firstRun: ReturnType<typeof setTimeout> | undefined;

export function startAccessListExpiry(): void {
  if (state.interval) return;
  clearTimeout(firstRun);
  firstRun = setTimeout(() => void tick(), FIRST_RUN_DELAY_MS);
  firstRun.unref?.();
  state.interval = setInterval(() => void tick(), ACCESS_LIST_EXPIRY_INTERVAL_MS);
  state.interval.unref?.();
  onShutdown("stopping the access list expiry job", stopAccessListExpiry);
}

export function stopAccessListExpiry(): void {
  clearTimeout(firstRun);
  firstRun = undefined;
  if (state.interval) clearInterval(state.interval);
  state.interval = null;
}
