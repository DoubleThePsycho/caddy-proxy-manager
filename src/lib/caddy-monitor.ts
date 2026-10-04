/**
 * Caddy health monitoring service
 * Monitors Caddy for restarts/recreations and automatically reapplies the
 * configuration Ingressi last pushed.
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
 * Check if Caddy is healthy and detect configuration drift
 */
async function checkCaddyHealth(): Promise<void> {
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

  if (hasDrifted) {
    if (reapplyPending) {
      return;
    }
    reapplyPending = true;
    console.log("[CaddyMonitor] Caddy configuration drift detected (restart or external change)! Waiting before reapplying...");

    // Wait a bit for Caddy to fully initialize
    setTimeout(() => void (async () => {
      try {
        console.log("[CaddyMonitor] Reapplying Caddy configuration after drift...");
        await applyCaddyConfig();
        console.log("[CaddyMonitor] Configuration reapplied successfully");
      } catch (error) {
        console.error("[CaddyMonitor] Failed to reapply configuration after drift:", error);
        // Will retry on next health check
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
