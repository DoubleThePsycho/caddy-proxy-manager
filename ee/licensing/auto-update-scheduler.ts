// SPDX-License-Identifier: Elastic-2.0
/**
 * Runs the daily license check (auto-update.ts) when it is due. Started from
 * src/instrumentation.ts (never in tests, never with
 * LICENSE_AUTO_UPDATE_DISABLED); looks every few minutes whether a check is
 * due. A failed check is not retried before the next daily slot and is
 * logged as one line at most once a day, without the refresh token or
 * anything the server sent. Nothing else waits for it: an install that
 * cannot reach the license server keeps its key until that key expires.
 */
import { getInstanceMode } from "@/src/lib/instance-sync";
import { MIN_ATTEMPT_SPACING_MS, nextDailyAttempt } from "@/src/lib/usage-ping/schedule";
import { getLicenseState } from "./store";
import { isLicenseAutoUpdateDisabledByEnv, resolveLicenseServer } from "./auto-update-env";
import {
  checkLicenseServer,
  readLicenseAutoUpdateSettings,
  readLicenseAutoUpdateState,
  writeLicenseAutoUpdateState,
  type LicenseAutoUpdateState,
} from "./auto-update";
import { onShutdown } from "@/src/lib/shutdown";

export const LICENSE_CHECK_INTERVAL_MS = 5 * 60_000;
const FAILURE_LOG_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type LicenseAutoUpdateRunOutcome =
  | "busy"
  | "disabled_by_env"
  | "replica"
  | "off"
  | "invalid_endpoint"
  | "no_license"
  | "license_mismatch"
  | "not_due"
  | "updated"
  | "current"
  | "failed"
  | "revoked"
  | "error";

const store = globalThis as typeof globalThis & {
  __ingressiLicenseAutoUpdate?: {
    interval: ReturnType<typeof setInterval> | null;
    running: boolean;
    /** The last check this process started, so a state that cannot be written never turns into a check every few minutes. */
    lastAttempt: { licenseId: string; at: number } | null;
    lastErrorLoggedAt: number | null;
  };
};
const scheduler = (store.__ingressiLicenseAutoUpdate ??= {
  interval: null,
  running: false,
  lastAttempt: null,
  lastErrorLoggedAt: null,
});

/** Lets tests start from a clean scheduler. */
export function resetLicenseAutoUpdateSchedulerForTests(): void {
  scheduler.running = false;
  scheduler.lastAttempt = null;
  scheduler.lastErrorLoggedAt = null;
}

function shouldLog(state: LicenseAutoUpdateState, now: Date): boolean {
  const last = state.lastFailureLoggedAt ? Date.parse(state.lastFailureLoggedAt) : NaN;
  return Number.isNaN(last) || now.getTime() - last >= FAILURE_LOG_INTERVAL_MS;
}

/** One look: checks with the license server if automatic updates are on and the daily slot has come. Never throws. */
export async function runLicenseAutoUpdateCheck(now: Date = new Date(), fetchImpl: typeof fetch = fetch): Promise<LicenseAutoUpdateRunOutcome> {
  if (scheduler.running) return "busy";
  scheduler.running = true;
  try {
    if (isLicenseAutoUpdateDisabledByEnv()) return "disabled_by_env";
    if ((await getInstanceMode()) === "slave") return "replica";
    const settings = await readLicenseAutoUpdateSettings();
    if (!settings?.enabled || settings.minuteOfDay === null || !settings.licenseId) return "off";
    if (!resolveLicenseServer().url) return "invalid_endpoint";
    const license = await getLicenseState(now);
    if (!license.license || license.status === "invalid") return "no_license";
    if (license.license.id !== settings.licenseId) return "license_mismatch";

    const state = await readLicenseAutoUpdateState();
    const due = state.nextCheckAt ? Date.parse(state.nextCheckAt) : NaN;
    if (Number.isNaN(due)) {
      // No schedule (lost state): the next daily slot, without asking now.
      await writeLicenseAutoUpdateState({ ...state, nextCheckAt: nextDailyAttempt(settings.minuteOfDay, now).toISOString() });
      return "not_due";
    }
    if (now.getTime() < due) return "not_due";
    const previous = scheduler.lastAttempt;
    if (previous?.licenseId === settings.licenseId && now.getTime() - previous.at < MIN_ATTEMPT_SPACING_MS && now.getTime() >= previous.at) {
      return "not_due";
    }
    scheduler.lastAttempt = { licenseId: settings.licenseId, at: now.getTime() };

    const outcome = await checkLicenseServer({ actorUserId: null, trigger: "scheduled", now, fetchImpl, reschedule: true });
    if (outcome === "failed" || outcome === "revoked") {
      const after = await readLicenseAutoUpdateState();
      if (shouldLog(after, now)) {
        console.warn(
          `[license] Checking the license server for a renewed key of license ${settings.licenseId} did not succeed ` +
            `(${after.lastError ?? outcome}); it is tried again with the next daily check`
        );
        await writeLicenseAutoUpdateState({ ...after, lastFailureLoggedAt: now.toISOString() });
      }
    }
    return outcome;
  } catch (error) {
    if (scheduler.lastErrorLoggedAt === null || now.getTime() - scheduler.lastErrorLoggedAt >= FAILURE_LOG_INTERVAL_MS) {
      scheduler.lastErrorLoggedAt = now.getTime();
      console.warn("[license] The daily license check failed:", error instanceof Error ? error.name : typeof error);
    }
    return "error";
  } finally {
    scheduler.running = false;
  }
}

/** Starts the periodic look unless LICENSE_AUTO_UPDATE_DISABLED is set; returns whether it runs. */
export function startLicenseAutoUpdateScheduler(): boolean {
  if (isLicenseAutoUpdateDisabledByEnv()) return false;
  if (scheduler.interval) return true;
  scheduler.interval = setInterval(() => void runLicenseAutoUpdateCheck(), LICENSE_CHECK_INTERVAL_MS);
  scheduler.interval.unref?.();
  onShutdown("stopping the license update scheduler", stopLicenseAutoUpdateScheduler);
  return true;
}

export function stopLicenseAutoUpdateScheduler(): void {
  if (scheduler.interval) clearInterval(scheduler.interval);
  scheduler.interval = null;
}
