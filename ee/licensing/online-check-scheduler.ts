// SPDX-License-Identifier: Elastic-2.0
/**
 * Runs the online license check (online-check.ts) when it is due: looks
 * every few minutes, asks once a confirmation is a day old or there is
 * none, and waits an hour after any attempt. Started from
 * src/instrumentation.ts (never in tests). Does nothing without an online
 * key, and never on a replica. A failed check is logged as one line at most
 * once a day, without anything the server sent.
 */
import { getInstanceMode } from "@/src/lib/instance-sync";
import { onShutdown } from "@/src/lib/shutdown";
import { requiresOnlineCheck, verifyLicenseKey } from "./license";
import { getTrustedLicenseKeys } from "./public-keys";
import { getLicenseKey } from "./store";
import { readLicenseCheck, readLicenseInstallId, writeLicenseCheck } from "./online-check-state";
import { installIdHash } from "./license";
import { isOnlineCheckDue, ONLINE_CHECK_RETRY_MS, runOnlineLicenseCheck, type OnlineCheckOutcome } from "./online-check";

export const ONLINE_CHECK_TICK_MS = 5 * 60_000;
const FAILURE_LOG_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type OnlineCheckTickOutcome = "busy" | "not_due" | "error" | OnlineCheckOutcome;

const store = globalThis as typeof globalThis & {
  __ingressiLicenseOnlineCheck?: {
    interval: ReturnType<typeof setInterval> | null;
    running: boolean;
    /** The last check this process started, so a state that cannot be written never turns into a check every few minutes. */
    lastAttempt: { licenseId: string; at: number } | null;
    lastErrorLoggedAt: number | null;
  };
};
const scheduler = (store.__ingressiLicenseOnlineCheck ??= {
  interval: null,
  running: false,
  lastAttempt: null,
  lastErrorLoggedAt: null,
});

/** Lets tests start from a clean scheduler. */
export function resetOnlineLicenseCheckSchedulerForTests(): void {
  scheduler.running = false;
  scheduler.lastAttempt = null;
  scheduler.lastErrorLoggedAt = null;
}

/** One look: checks with the license server when an online key is installed and a check is due. Never throws. */
export async function runOnlineLicenseCheckTick(now: Date = new Date(), fetchImpl: typeof fetch = fetch): Promise<OnlineCheckTickOutcome> {
  if (scheduler.running) return "busy";
  scheduler.running = true;
  try {
    if ((await getInstanceMode()) === "slave") return "replica";
    const key = await getLicenseKey();
    if (!key) return "not_required";
    let licenseId: string;
    try {
      const payload = verifyLicenseKey(key, getTrustedLicenseKeys());
      if (!requiresOnlineCheck(payload)) return "not_required";
      licenseId = payload.id;
    } catch {
      return "not_required";
    }

    const installId = await readLicenseInstallId();
    if (!isOnlineCheckDue(await readLicenseCheck(), licenseId, now, installId ? installIdHash(installId) : null)) return "not_due";
    const previous = scheduler.lastAttempt;
    if (previous?.licenseId === licenseId && now.getTime() >= previous.at && now.getTime() - previous.at < ONLINE_CHECK_RETRY_MS) {
      return "not_due";
    }
    scheduler.lastAttempt = { licenseId, at: now.getTime() };

    const outcome = await runOnlineLicenseCheck({ now, fetchImpl, actorUserId: null });
    if (outcome === "failed") {
      const after = await readLicenseCheck();
      const last = after.lastFailureLoggedAt ? Date.parse(after.lastFailureLoggedAt) : NaN;
      if (Number.isNaN(last) || now.getTime() - last >= FAILURE_LOG_INTERVAL_MS) {
        console.warn(
          `[license] Confirming license ${licenseId} with the license server did not succeed (${after.lastError ?? "no answer"}); ` +
            "it is tried again within the hour"
        );
        await writeLicenseCheck({ ...after, lastFailureLoggedAt: now.toISOString() });
      }
    }
    return outcome;
  } catch (error) {
    if (scheduler.lastErrorLoggedAt === null || now.getTime() - scheduler.lastErrorLoggedAt >= FAILURE_LOG_INTERVAL_MS) {
      scheduler.lastErrorLoggedAt = now.getTime();
      console.warn("[license] The online license check failed:", error instanceof Error ? error.name : typeof error);
    }
    return "error";
  } finally {
    scheduler.running = false;
  }
}

/** Starts the periodic look; returns whether it runs. */
export function startOnlineLicenseCheckScheduler(): boolean {
  if (scheduler.interval) return true;
  scheduler.interval = setInterval(() => void runOnlineLicenseCheckTick(), ONLINE_CHECK_TICK_MS);
  scheduler.interval.unref?.();
  onShutdown("stopping the online license check", stopOnlineLicenseCheckScheduler);
  // The first look soon after start, not five minutes later.
  setTimeout(() => void runOnlineLicenseCheckTick(), 30_000).unref?.();
  return true;
}

export function stopOnlineLicenseCheckScheduler(): void {
  if (scheduler.interval) clearInterval(scheduler.interval);
  scheduler.interval = null;
}
