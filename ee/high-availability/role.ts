// SPDX-License-Identifier: Elastic-2.0
/**
 * This dashboard process's place in a high availability cluster
 * (ee/high-availability/cluster, ee/docs/high-availability.md).
 *
 * The cluster supervisor starts the dashboard with HA_ROLE=leader or
 * HA_ROLE=standby and HA_STATUS_FILE pointing at the status it keeps current.
 * Without HA_ROLE (the default, high availability off) the process is a
 * standalone dashboard and nothing here changes anything.
 */
import { readFileSync } from "node:fs";

export type HaRole = "standalone" | "leader" | "standby";

export function getHaRole(): HaRole {
  const role = process.env.HA_ROLE;
  return role === "leader" || role === "standby" ? role : "standalone";
}

export function isHaStandby(): boolean {
  return getHaRole() === "standby";
}

/** What the dashboard reads of the supervisor's status file. */
export type HaStatusSnapshot = {
  role: string;
  nodeId: string;
  /** Leader only: after this time, without a renewal, the node must stop acting as the leader. */
  fenceAt: string | null;
  /** Standby only: a warm copy of the database is open for the request-path routes. */
  copyReady: boolean;
};

const CACHE_MS = 1_000;
let cached: { at: number; path: string; value: HaStatusSnapshot | null } | null = null;

/** The supervisor's status, read at most once a second; null without one. */
export function readHaStatus(now: number = Date.now()): HaStatusSnapshot | null {
  const path = process.env.HA_STATUS_FILE;
  if (!path) return null;
  if (cached && cached.path === path && now - cached.at < CACHE_MS) return cached.value;
  let value: HaStatusSnapshot | null = null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (typeof parsed.role === "string" && typeof parsed.nodeId === "string") {
      const follow = parsed.follow as { ready?: unknown } | null | undefined;
      value = {
        role: parsed.role,
        nodeId: parsed.nodeId,
        fenceAt: typeof parsed.fenceAt === "string" ? parsed.fenceAt : null,
        copyReady: follow?.ready === true,
      };
    }
  } catch {
    value = null;
  }
  cached = { at: now, path, value };
  return value;
}

/** Forgets the cached status (tests). */
export function resetHaStatusCache(): void {
  cached = null;
}

/**
 * The leader still holds its lease as far as this process can tell: the
 * supervisor says it is the leader and its fencing deadline has not passed.
 */
export function leaderLeaseValid(now: number = Date.now()): boolean {
  if (getHaRole() !== "leader") return false;
  const status = readHaStatus(now);
  if (!status || status.role !== "leader" || !status.fenceAt) return false;
  const fenceAt = Date.parse(status.fenceAt);
  return Number.isFinite(fenceAt) && now < fenceAt;
}

/**
 * A second fence next to the supervisor's: a leader dashboard whose lease
 * can no longer be vouched for (the supervisor stopped renewing it, or says
 * the node is no longer the leader) exits at once instead of serving writes.
 * Returns a function that stops the watchdog.
 */
export function startLeaderWatchdog(onFenced: () => void = () => process.exit(70), intervalMs = 1_000): () => void {
  if (getHaRole() !== "leader") return () => {};
  const timer = setInterval(() => {
    if (!leaderLeaseValid()) {
      console.error("High availability: this node no longer holds the leader lease; stopping the dashboard");
      clearInterval(timer);
      onFenced();
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
