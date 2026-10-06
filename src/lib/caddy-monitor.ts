/**
 * Caddy health monitoring service
 * Monitors Caddy for restarts/recreations and automatically reapplies the
 * configuration Ingressi last pushed.
 *
 * It also retries an apply that failed because Caddy could not be reached
 * (restarted at the same moment as the dashboard, e.g. by an image update):
 * Caddy then comes back with its saved configuration, which matches the last
 * successful apply, so there is no drift to see, but the dashboard's newer
 * configuration never reached it.
 *
 * Detection is content-based: after every successful apply, `applyCaddyConfig`
 * records a fingerprint (sha256) of the config Caddy is actually serving, in
 * the database (caddy-apply-status.ts), so an apply by another replica is
 * the expected configuration too. Each health check re-fetches the live
 * config and compares — any difference means Caddy is no longer running our
 * configuration (container recreated with a missing/stale autosave,
 * restarted onto the image's default Caddyfile, externally modified, or an
 * apply that lost its cluster lock pushed an older document last) and the
 * configuration is applied again.
 * A hash comparison is the only reliable signal: Caddy may come back with a
 * non-empty config (the default Caddyfile defines an `http` app), so checks
 * like "is the config empty" or "did the ETag disappear" miss real drift.
 */

import { applyCaddyConfig, getAppliedConfigHash, getCaddyLiveConfigHash } from "./caddy";
import { getCaddyApplyStatus, type CaddyApplyStatus } from "./caddy-apply-status";
import { config } from "./config";

type CaddyMonitorState = {
  isHealthy: boolean;
  /** Fingerprint of the config Caddy was last seen serving (debug aid). */
  lastConfigId: string | null;
  lastCheckTime: number;
  consecutiveFailures: number;
};

const HEALTH_CHECK_INTERVAL = 10000; // Check every 10 seconds
const MAX_CONSECUTIVE_FAILURES = 3; // Consider unhealthy after 3 failures
const REAPPLY_DELAY = 5000; // Wait 5 seconds after detecting drift before reapplying
const RETRY_MAX_WAIT = 5 * 60_000; // At most this long between retries of a failed apply

/** Failures a later attempt can fix on its own: Caddy did not answer, or the request broke. */
const RETRIABLE_FAILURES: ReadonlySet<string> = new Set(["CADDY_UNREACHABLE", "CADDY_REQUEST_FAILED"]);

/**
 * Whether the last apply failed in a way that retrying can fix, and its
 * back-off has passed: 5 s after the first failure, doubling up to 5 minutes.
 * A configuration Caddy rejected, or that could not be built, waits for a change.
 */
export function failedApplyRetryDue(status: CaddyApplyStatus | null, now: number): boolean {
  if (!status || status.ok || !status.code || !RETRIABLE_FAILURES.has(status.code)) return false;
  const failedAt = Date.parse(status.at);
  if (!Number.isFinite(failedAt)) return true;
  const wait = Math.min(RETRY_MAX_WAIT, REAPPLY_DELAY * 2 ** Math.max(0, status.consecutiveFailures - 1));
  return now - failedAt >= wait;
}

const monitorState: CaddyMonitorState = {
  isHealthy: false,
  lastConfigId: null,
  lastCheckTime: 0,
  consecutiveFailures: 0
};

let monitorInterval: NodeJS.Timeout | null = null;
let isMonitoring = false;
// True while a drift-triggered reapply is scheduled/running, so a health
// check landing inside the REAPPLY_DELAY window doesn't schedule another one.
let reapplyPending = false;

/**
 * Check if Caddy is healthy and detect configuration drift (exported for tests)
 */
export async function checkCaddyHealth(): Promise<void> {
  monitorState.lastCheckTime = Date.now();

  const liveConfigId = await getCaddyLiveConfigHash();

  if (liveConfigId === null) {
    // Caddy is not responding
    monitorState.consecutiveFailures++;

    if (monitorState.isHealthy && monitorState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.warn(
        `[CaddyMonitor] Caddy appears to be down (${monitorState.consecutiveFailures} consecutive failures)`
      );
      monitorState.isHealthy = false;
    }
    return;
  }

  // Caddy is responding
  monitorState.consecutiveFailures = 0;
  monitorState.isHealthy = true;
  monitorState.lastConfigId = liveConfigId;

  const expectedConfigId = await getAppliedConfigHash();
  const hasDrifted = expectedConfigId !== null && liveConfigId !== expectedConfigId;
  const retryFailed = !hasDrifted && failedApplyRetryDue(await getCaddyApplyStatus(), Date.now());

  if (hasDrifted || retryFailed) {
    if (reapplyPending) {
      return;
    }
    reapplyPending = true;
    const reason = hasDrifted ? "after drift" : "after a failed apply";
    console.log(
      hasDrifted
        ? "[CaddyMonitor] Caddy configuration drift detected (restart or external change)! Waiting before reapplying..."
        : "[CaddyMonitor] Caddy answers again after an apply could not reach it. Waiting before reapplying..."
    );

    // Wait a bit for Caddy to fully initialize
    setTimeout(() => void (async () => {
      try {
        console.log(`[CaddyMonitor] Reapplying Caddy configuration ${reason}...`);
        await applyCaddyConfig();
        console.log("[CaddyMonitor] Configuration reapplied successfully");
      } catch (error) {
        console.error(`[CaddyMonitor] Failed to reapply configuration ${reason}:`, error);
        // Will retry on a later health check (with back-off for a failed apply)
      } finally {
        reapplyPending = false;
      }
    })(), REAPPLY_DELAY);
  }
}

/**
 * Start monitoring Caddy health
 */
export function startCaddyMonitoring(): void {
  if (!config.caddyMonitorEnabled) {
    console.log(
      "[CaddyMonitor] Disabled (CADDY_MONITOR_ENABLED=false) — this instance does not own the targeted Caddy"
    );
    return;
  }
  if (isMonitoring) {
    console.log("[CaddyMonitor] Already monitoring");
    return;
  }

  console.log(`[CaddyMonitor] Starting Caddy health monitoring (interval: ${HEALTH_CHECK_INTERVAL}ms)`);
  isMonitoring = true;

  // Do initial check immediately
  checkCaddyHealth().catch((error) => {
    console.error("[CaddyMonitor] Initial health check failed:", error);
  });

  // Set up periodic checks
  monitorInterval = setInterval(() => {
    checkCaddyHealth().catch((error) => {
      console.error("[CaddyMonitor] Health check failed:", error);
    });
  }, HEALTH_CHECK_INTERVAL);
}

/**
 * Stop monitoring Caddy health
 */
export function stopCaddyMonitoring(): void {
  if (!isMonitoring) {
    return;
  }

  console.log("[CaddyMonitor] Stopping Caddy health monitoring");
  isMonitoring = false;

  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}

/**
 * Get current monitoring state (useful for debugging)
 */
export function getMonitorState(): Readonly<CaddyMonitorState> {
  return { ...monitorState };
}
