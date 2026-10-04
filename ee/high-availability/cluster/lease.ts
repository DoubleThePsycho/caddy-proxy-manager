// SPDX-License-Identifier: Elastic-2.0
/**
 * Keeping the leader lease: renew it well inside its TTL with the
 * compare-and-renew script, and fence this node when that fails.
 *
 * The fencing deadline is local and conservative: the time the request that
 * obtained or last renewed the lease was *sent*, plus the TTL, minus a
 * margin. Redis set the expiry after it received that request, so the lease
 * in Redis outlives the local deadline; once the deadline passes without a
 * renewal, another node may take the lease at any moment and this node must
 * already have stopped (crash-only: the supervisor kills the dashboard and
 * Litestream and exits, and the container restarts as a standby).
 */
import type { LeaseRecord, LeaseStore } from "./lease-store";

export type TimerHandle = ReturnType<typeof setTimeout>;

/** Time and timers, replaced in tests. */
export type Clock = {
  now(): number;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** A renewal every third of the TTL. */
export function renewIntervalMs(ttlMs: number): number {
  return Math.max(500, Math.floor(ttlMs / 3));
}

/** Room left for stopping before the lease can expire in Redis: a fifth of the TTL, at most 2 seconds. */
export function fenceMarginMs(ttlMs: number): number {
  return Math.min(2_000, Math.floor(ttlMs / 5));
}

/** Retries after a failed renewal (Redis unreachable) come quicker than the normal interval. */
const RETRY_INTERVAL_MS = 1_000;

export type LeaseKeeperOptions = {
  ttlMs: number;
  clock?: Clock;
  /** The lease is lost or could not be renewed in time: fence now. Called once. */
  onLost: (reason: string) => void;
  /** After every successful renewal, with the new deadline. */
  onRenewed?: (fenceAt: number) => void;
  /** After a failed renewal attempt that left time to retry. */
  onRenewFailed?: (message: string) => void;
};

export class LeaseKeeper {
  private readonly clock: Clock;
  private deadline: number;
  private fenceTimer: TimerHandle | null = null;
  private renewTimer: TimerHandle | null = null;
  private active = false;
  private lost = false;
  private renewing = false;

  /** `requestedAt`: when the request that obtained the lease was sent. */
  constructor(
    private readonly store: LeaseStore,
    readonly lease: LeaseRecord,
    requestedAt: number,
    private readonly options: LeaseKeeperOptions
  ) {
    this.clock = options.clock ?? systemClock;
    this.deadline = requestedAt + options.ttlMs - fenceMarginMs(options.ttlMs);
  }

  /** After this time, without a renewal, the node must not act as the leader. */
  get fenceAt(): number {
    return this.deadline;
  }

  get isLost(): boolean {
    return this.lost;
  }

  start(): void {
    if (this.active || this.lost) return;
    this.active = true;
    this.armFence();
    if (this.clock.now() >= this.deadline) {
      this.fence("the lease was obtained too late to use");
      return;
    }
    this.scheduleRenewal(renewIntervalMs(this.options.ttlMs));
  }

  /** Stops renewing (graceful shutdown or after fencing). The lease is left to expire unless released. */
  stop(): void {
    this.active = false;
    if (this.fenceTimer) this.clock.clearTimeout(this.fenceTimer);
    if (this.renewTimer) this.clock.clearTimeout(this.renewTimer);
    this.fenceTimer = null;
    this.renewTimer = null;
  }

  /** Stops and gives the lease up, so a standby can take over without waiting for the TTL. */
  async release(timeoutMs = 2_000): Promise<boolean> {
    this.stop();
    if (this.lost) return false;
    try {
      return await this.store.release(this.lease, timeoutMs);
    } catch {
      return false;
    }
  }

  private armFence() {
    if (this.fenceTimer) this.clock.clearTimeout(this.fenceTimer);
    const wait = Math.max(0, this.deadline - this.clock.now());
    this.fenceTimer = this.clock.setTimeout(() => {
      if (this.active && this.clock.now() >= this.deadline) this.fence("the lease could not be renewed before it expired");
    }, wait);
  }

  private scheduleRenewal(ms: number) {
    if (!this.active) return;
    if (this.renewTimer) this.clock.clearTimeout(this.renewTimer);
    this.renewTimer = this.clock.setTimeout(() => void this.renew(), ms);
  }

  private fence(reason: string) {
    if (this.lost) return;
    this.lost = true;
    this.stop();
    this.options.onLost(reason);
  }

  private async renew() {
    if (!this.active || this.renewing) return;
    this.renewing = true;
    const sentAt = this.clock.now();
    const timeout = this.deadline - sentAt;
    try {
      if (timeout <= 0) {
        this.fence("the lease could not be renewed before it expired");
        return;
      }
      const ok = await this.store.renew(this.lease, this.options.ttlMs, timeout);
      if (!this.active) return;
      if (!ok) {
        this.fence("another node holds the lease now");
        return;
      }
      if (this.clock.now() >= this.deadline) {
        // The answer came after the deadline; the fence timer may not have fired yet.
        this.fence("the lease could not be renewed before it expired");
        return;
      }
      this.deadline = sentAt + this.options.ttlMs - fenceMarginMs(this.options.ttlMs);
      this.armFence();
      this.options.onRenewed?.(this.deadline);
      this.scheduleRenewal(renewIntervalMs(this.options.ttlMs));
    } catch (error) {
      if (!this.active) return;
      this.options.onRenewFailed?.(error instanceof Error ? error.message : "the renewal failed");
      this.scheduleRenewal(Math.min(RETRY_INTERVAL_MS, renewIntervalMs(this.options.ttlMs)));
    } finally {
      this.renewing = false;
    }
  }
}
