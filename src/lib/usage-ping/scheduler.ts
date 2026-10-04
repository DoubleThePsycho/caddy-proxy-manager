/**
 * Sends the usage ping when it is due. Started from src/instrumentation.ts
 * (never in tests, never with USAGE_PING_DISABLED); checks once a minute
 * whether a ping is due (schedule.ts) and whether an erasure request is
 * waiting to be retried.
 *
 * A ping is one POST with a 10 second time limit (transport.ts). Redirects
 * are not followed, a failure is not retried before the next daily slot, and
 * it is logged as a single line at most once a day. Nothing else in the
 * dashboard waits for it or depends on its outcome.
 */
import { getInstanceMode } from "@/src/lib/instance-sync";
import { isUsagePingDisabledByEnv, resolveUsagePingEndpoint } from "./env";
import { MIN_ATTEMPT_SPACING_MS, nextDailyAttempt } from "./schedule";
import {
  buildUsagePingPayloadFor,
  readUsagePingSettings,
  readUsagePingState,
  retryPendingErasures,
  writeUsagePingState,
  type UsagePingState,
} from "./store";
import { sendUsagePing, type UsagePingSendResult } from "./transport";
import { onShutdown } from "@/src/lib/shutdown";

export { sendUsagePing, USAGE_PING_TIMEOUT_MS, type UsagePingSendResult } from "./transport";

export const USAGE_PING_CHECK_INTERVAL_MS = 60_000;
const FAILURE_LOG_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type UsagePingCheckOutcome =
  | "busy"
  | "disabled_by_env"
  | "off"
  | "replica"
  | "not_due"
  | "sent"
  | "failed"
  | "error";

const store = globalThis as typeof globalThis & {
  __ingressiUsagePing?: {
    interval: ReturnType<typeof setInterval> | null;
    running: boolean;
    /**
     * The last attempt this process started, so that a state that cannot be
     * written (a database error) never turns into an attempt every minute.
     */
    lastAttempt: { installId: string; at: number } | null;
    /** For failures outside an attempt (the database), which have no stored state. */
    lastErrorLoggedAt: number | null;
  };
};
const scheduler = (store.__ingressiUsagePing ??= {
  interval: null,
  running: false,
  lastAttempt: null,
  lastErrorLoggedAt: null,
});

function logFailureOncePerDay(state: UsagePingState, now: Date, reason: string): UsagePingState {
  const last = state.lastFailureLoggedAt ? Date.parse(state.lastFailureLoggedAt) : NaN;
  if (!Number.isNaN(last) && now.getTime() - last < FAILURE_LOG_INTERVAL_MS) return state;
  console.warn(`[usage-ping] The anonymous usage ping was not sent (${reason}); it is tried again with the next daily ping`);
  return { ...state, lastFailureLoggedAt: now.toISOString() };
}

/**
 * One check: sends the ping if it is on and due. Skipped while a previous
 * check is still running. Never throws.
 */
export async function runUsagePingCheck(now: Date = new Date(), fetchImpl: typeof fetch = fetch): Promise<UsagePingCheckOutcome> {
  if (scheduler.running) return "busy";
  scheduler.running = true;
  try {
    if (isUsagePingDisabledByEnv()) return "disabled_by_env";
    const role = await getInstanceMode();
    if (role === "slave") return "replica";
    await retryPendingErasures(now, fetchImpl);
    const settings = await readUsagePingSettings();
    if (!settings?.enabled || !settings.installId || settings.minuteOfDay === null) return "off";

    const state = await readUsagePingState();
    const due = state.nextAttemptAt ? Date.parse(state.nextAttemptAt) : NaN;
    if (Number.isNaN(due)) {
      // No schedule (lost state): the next daily slot, without sending now.
      await writeUsagePingState({ ...state, nextAttemptAt: nextDailyAttempt(settings.minuteOfDay, now).toISOString() });
      return "not_due";
    }
    if (now.getTime() < due) return "not_due";
    const previous = scheduler.lastAttempt;
    if (previous?.installId === settings.installId && now.getTime() - previous.at < MIN_ATTEMPT_SPACING_MS) return "not_due";
    scheduler.lastAttempt = { installId: settings.installId, at: now.getTime() };

    const endpoint = resolveUsagePingEndpoint();
    const result: UsagePingSendResult = endpoint.url
      ? await sendUsagePing(endpoint.url, await buildUsagePingPayloadFor(settings.installId, role), fetchImpl)
      : { ok: false, error: endpoint.error ?? "no endpoint" };

    // Opted out (or the id was reset) while the ping was out: leave the new state alone.
    const after = await readUsagePingSettings();
    if (!after?.enabled || after.installId !== settings.installId) return result.ok ? "sent" : "failed";

    let next: UsagePingState = {
      ...state,
      nextAttemptAt: nextDailyAttempt(settings.minuteOfDay, now).toISOString(),
      lastAttemptAt: now.toISOString(),
      lastSuccessAt: result.ok ? now.toISOString() : state.lastSuccessAt,
      lastResult: result.ok ? "sent" : "failed",
      lastError: result.ok ? null : result.error,
    };
    if (!result.ok) next = logFailureOncePerDay(next, now, result.error);
    await writeUsagePingState(next);
    return result.ok ? "sent" : "failed";
  } catch (error) {
    if (scheduler.lastErrorLoggedAt === null || now.getTime() - scheduler.lastErrorLoggedAt >= FAILURE_LOG_INTERVAL_MS) {
      scheduler.lastErrorLoggedAt = now.getTime();
      console.warn("[usage-ping] The usage ping check failed:", error instanceof Error ? error.name : typeof error);
    }
    return "error";
  } finally {
    scheduler.running = false;
  }
}

/** Starts the minute check unless USAGE_PING_DISABLED is set; returns whether it runs. */
export function startUsagePingScheduler(): boolean {
  if (isUsagePingDisabledByEnv()) return false;
  if (scheduler.interval) return true;
  scheduler.interval = setInterval(() => void runUsagePingCheck(), USAGE_PING_CHECK_INTERVAL_MS);
  scheduler.interval.unref?.();
  onShutdown("stopping the usage ping scheduler", stopUsagePingScheduler);
  return true;
}

export function stopUsagePingScheduler(): void {
  if (scheduler.interval) clearInterval(scheduler.interval);
  scheduler.interval = null;
}
