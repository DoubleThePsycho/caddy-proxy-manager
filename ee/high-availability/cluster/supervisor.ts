// SPDX-License-Identifier: Elastic-2.0
/**
 * The high availability supervisor: the web container's first process when
 * HA_ENABLED is set. It holds (or waits for) the leader lease and runs the
 * dashboard and Litestream as child processes:
 *
 *   standby    the dashboard runs with HA_ROLE=standby (health 503, the
 *              request-path routes only, a read-only warm copy of the
 *              database kept by `litestream restore -f`); every couple of
 *              seconds the node tries to take the lease.
 *   promoting  it took the lease (renewed from now on): it stops its
 *              standby processes, restores the newest replica, starts
 *              `litestream replicate` to a new replica of its own, waits until
 *              that replica holds a full copy, points the cluster at it, and
 *              only then starts the dashboard as the leader.
 *   leader     the dashboard runs with HA_ROLE=leader (schedulers, syncs and
 *              background jobs included). Losing the lease, or failing to
 *              renew it before the local deadline, kills the dashboard and
 *              Litestream at once and exits: the container restarts as a
 *              standby (crash-only fencing).
 *
 * A promotion that fails (no replica can be restored, object storage or Redis
 * unreachable) gives the lease back and
 * retries later with a growing delay; it never starts the dashboard on a
 * database it could not vouch for.
 */
import { randomBytes } from "node:crypto";
import type { HaConfig } from "./config";
import { LeaseKeeper, systemClock, type Clock, type TimerHandle } from "./lease";
import type { LeaseRecord, LeaseStore, ReplicaPointer } from "./lease-store";
import type { ProcessHandle } from "./litestream";
import type { LocalDatabase } from "./local-db";
import { replicaEpoch, type ReplicaStore } from "./replica-store";
import type {
  FollowStatus,
  NodeReport,
  NodeRole,
  NodeStatusFile,
  ReplicationStatus,
  RestoreRecord,
  RestoreSource,
} from "./types";

export type AppRole = "leader" | "standby";

/** Starts the dashboard process. */
export interface AppLauncher {
  /** `databasePath`: the file the dashboard opens (null: a standby without a warm copy yet). */
  start(role: AppRole, databasePath: string | null): ProcessHandle;
}

/** What the supervisor needs of Litestream (litestream.ts); tests pass a fake. */
export interface LitestreamPort {
  restore(replicaId: string, outputPath: string): Promise<boolean>;
  startReplicate(replicaId: string): ProcessHandle;
  startFollow(replicaId: string): ProcessHandle;
  lastSyncAt(): Promise<Date | null>;
  standbyCopyPath(replicaId: string): string;
  /** The warm copy of `replicaId` has been restored and can be opened. */
  standbyCopyReady(replicaId: string): boolean;
  removeOtherStandbyCopies(keepReplicaId: string | null): void;
}

export type SupervisorTiming = {
  /** Standby loop: read the lease, try to take it. */
  acquireIntervalMs: number;
  /** Leader loop: replication status, node list, checks. */
  leaderLoopMs: number;
  /** Longest wait for the first copy to reach the new replica. */
  firstSyncTimeoutMs: number;
  /** Wait for a child to stop after SIGTERM before SIGKILL. */
  stopTimeoutMs: number;
  /** First retry delay after a failed promotion; doubles up to promotionBackoffMaxMs. */
  promotionBackoffMs: number;
  promotionBackoffMaxMs: number;
  /** How often the leader checks that its replica still exists in object storage. */
  verifyIntervalMs: number;
  /** Replicas of earlier terms are deleted this long after becoming the leader. */
  pruneDelayMs: number;
  /** Node reports older than this are dropped from the list. */
  staleNodeMs: number;
  /** Delay before restarting a child that stopped on its own. */
  restartDelayMs: number;
  /** A standby reads cluster.json from object storage at most this often (when Redis has no pointer). */
  bucketPointerIntervalMs: number;
};

export function defaultTiming(ttlMs: number): SupervisorTiming {
  return {
    acquireIntervalMs: Math.min(2_000, Math.floor(ttlMs / 3)),
    leaderLoopMs: 5_000,
    firstSyncTimeoutMs: 120_000,
    stopTimeoutMs: 15_000,
    promotionBackoffMs: 5_000,
    promotionBackoffMaxMs: 60_000,
    verifyIntervalMs: 5 * 60_000,
    pruneDelayMs: 60_000,
    staleNodeMs: 15 * 60_000,
    restartDelayMs: 5_000,
    bucketPointerIntervalMs: 60_000,
  };
}

export type SupervisorDeps = {
  config: HaConfig;
  store: LeaseStore;
  replicas: ReplicaStore;
  litestream: LitestreamPort;
  app: AppLauncher;
  local: LocalDatabase;
  writeStatus: (status: NodeStatusFile) => void;
  exit: (code: number) => void;
  clock?: Clock;
  log?: (message: string) => void;
  randomHex?: (bytes: number) => string;
  timing?: Partial<SupervisorTiming>;
};

/** A promotion cannot go on; the message is fixed text, safe to show. */
export class PromotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromotionError";
  }
}

/** Raised inside a promotion once the node has been fenced: nothing more may happen. */
class FencedError extends Error {}

type Child = { handle: ProcessHandle; exited: boolean; restartAt: number };
type AppChild = Child & { role: AppRole; databasePath: string | null };
type FollowChild = Child & { replicaId: string };
type ReplicateChild = Child & { replicaId: string };

type RestorePlan = {
  source: RestoreSource;
  /** The replica restored from (also when it turned out empty). */
  replicaId: string | null;
  /** The restored file to put in place; null keeps this node's own database. */
  restoredPath: string | null;
};

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message.slice(0, 300) : fallback;
}

export class Supervisor {
  private readonly config: HaConfig;
  private readonly clock: Clock;
  private readonly timing: SupervisorTiming;
  private readonly log: (message: string) => void;
  private readonly randomHex: (bytes: number) => string;
  /** This process's lease token: a restarted container never reuses one. */
  private readonly token: string;
  private readonly startedAt: string;

  role: NodeRole = "standby";
  private keeper: LeaseKeeper | null = null;
  private lease: LeaseRecord | null = null;
  private app: AppChild | null = null;
  private follow: FollowChild | null = null;
  private followError: string | null = null;
  private replicate: ReplicateChild | null = null;
  /** The newest replica pointer seen (Redis or object storage). */
  private pointer: ReplicaPointer | null = null;
  /** No acquisition below this epoch (raised when object storage knows a newer term than Redis). */
  private epochFloor = 0;
  private bucketPointerReadAt = 0;
  private pendingBucketPointer: ReplicaPointer | null = null;
  private leaseStatus: NodeStatusFile["lease"] = { holder: null, epoch: null, checkedAt: null, error: null };
  private replication: ReplicationStatus | null = null;
  private lastRestore: RestoreRecord | null = null;
  private nodes: NodeReport[] = [];
  private promotionFailures = 0;
  private promotionBlockedUntil = 0;
  private leaderSince = 0;
  private lastVerifyAt = 0;
  private pruned = false;
  private timer: TimerHandle | null = null;
  private stopping = false;
  private busy = false;

  constructor(private readonly deps: SupervisorDeps) {
    this.config = deps.config;
    this.clock = deps.clock ?? systemClock;
    this.timing = { ...defaultTiming(deps.config.leaseTtlMs), ...deps.timing };
    this.log = deps.log ?? ((line) => console.log(`[ha] ${line}`));
    this.randomHex = deps.randomHex ?? ((bytes) => randomBytes(bytes).toString("hex"));
    this.token = this.randomHex(16);
    this.startedAt = new Date(this.clock.now()).toISOString();
  }

  private now(): number {
    return this.clock.now();
  }

  private iso(at = this.now()): string {
    return new Date(at).toISOString();
  }

  // ── Loop ────────────────────────────────────────────────────────────────

  /** Starts the loop: standby first, always. */
  start(): void {
    this.log(`node ${this.config.nodeId} starting as a standby`);
    this.writeStatus();
    this.schedule(0);
  }

  private schedule(ms: number) {
    if (this.stopping) return;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => void this.loop(), ms);
  }

  private async loop() {
    if (this.stopping || this.busy) return;
    this.busy = true;
    try {
      if (this.role === "standby") await this.standbyTick();
      else if (this.role === "leader") await this.leaderTick();
    } catch (error) {
      this.log(`unexpected error: ${message(error, "unknown")}`);
    } finally {
      this.busy = false;
    }
    if (this.role === "leader") this.schedule(this.timing.leaderLoopMs);
    else if (this.role === "standby") this.schedule(this.timing.acquireIntervalMs);
  }

  // ── Standby ─────────────────────────────────────────────────────────────

  private notePointer(pointer: ReplicaPointer | null) {
    if (!pointer) return;
    if (!this.pointer || pointer.epoch > this.pointer.epoch || (pointer.epoch === this.pointer.epoch && pointer.replicaId !== this.pointer.replicaId)) {
      this.pointer = pointer;
    }
    this.epochFloor = Math.max(this.epochFloor, pointer.epoch);
  }

  /** One standby round: read the lease, keep the warm copy and the dashboard going, take the lease when it is free. */
  async standbyTick(): Promise<void> {
    if (this.role !== "standby" || this.stopping) return;
    const timeout = this.timing.acquireIntervalMs * 2;
    let holder: LeaseRecord | null;
    try {
      holder = await this.deps.store.read(timeout);
      const pointer = await this.deps.store.readPointer(timeout);
      this.notePointer(pointer);
      this.leaseStatus = { holder: holder?.nodeId ?? null, epoch: holder?.epoch ?? null, checkedAt: this.iso(), error: null };
      if (!pointer) await this.readBucketPointer();
    } catch (error) {
      this.leaseStatus = { ...this.leaseStatus, checkedAt: this.iso(), error: message(error, "Redis or Valkey cannot be reached") };
      await this.ensureStandbyProcesses();
      this.writeStatus();
      return;
    }

    await this.ensureStandbyProcesses();
    await this.report();

    if (!holder && this.now() >= this.promotionBlockedUntil && !this.stopping) {
      const requestedAt = this.now();
      let lease: LeaseRecord | null = null;
      try {
        lease = await this.deps.store.acquire(this.token, this.config.nodeId, this.config.leaseTtlMs, this.epochFloor, timeout);
      } catch (error) {
        this.leaseStatus = { ...this.leaseStatus, error: message(error, "Redis or Valkey cannot be reached") };
      }
      if (lease) {
        await this.promote(lease, requestedAt);
        return;
      }
    }
    this.writeStatus();
  }

  /** Reads cluster.json when Redis has no pointer (Redis lost its data, or a first start), at most once a minute. */
  private async readBucketPointer() {
    if (this.now() - this.bucketPointerReadAt < this.timing.bucketPointerIntervalMs && this.bucketPointerReadAt !== 0) return;
    this.bucketPointerReadAt = this.now();
    try {
      this.notePointer(await this.deps.replicas.readPointer());
    } catch {
      // Object storage is checked again before any promotion.
    }
  }

  private async ensureStandbyProcesses() {
    if (this.role !== "standby" || this.stopping) return;
    const target = this.pointer?.replicaId ?? null;
    if (this.config.followIntervalSeconds > 0 && target) {
      if (this.follow && this.follow.replicaId !== target) {
        await this.stopChild(this.follow);
        this.follow = null;
      }
      if (!this.follow || (this.follow.exited && this.now() >= this.follow.restartAt)) {
        const handle = this.deps.litestream.startFollow(target);
        const child: FollowChild = { handle, exited: false, restartAt: 0, replicaId: target };
        this.follow = child;
        this.followError = null;
        void handle.exited.then((result) => {
          child.exited = true;
          child.restartAt = this.now() + this.timing.restartDelayMs;
          if (this.follow === child && !this.stopping) {
            this.followError = `the warm copy stopped (litestream exited with ${result.code ?? result.signal}); retrying`;
          }
        });
      }
    }
    const ready = target && this.config.followIntervalSeconds > 0 && this.deps.litestream.standbyCopyReady(target) ? target : null;
    // Until a new copy is ready, a running standby dashboard keeps the copy it has open.
    const keep = this.app && this.app.role === "standby" && !this.app.exited ? this.app.databasePath : null;
    const databasePath = ready ? this.deps.litestream.standbyCopyPath(ready) : keep;
    await this.ensureApp("standby", databasePath);
  }

  // ── Promotion ───────────────────────────────────────────────────────────

  private guard() {
    if (this.stopping || this.keeper?.isLost || this.role !== "promoting") throw new FencedError();
  }

  /** Decides what to restore, and restores it into a temporary file when there is a replica. */
  private async planRestore(lease: LeaseRecord): Promise<RestorePlan | "raise-epoch"> {
    const timeout = this.timing.acquireIntervalMs * 2;
    let redisPointer: ReplicaPointer | null;
    try {
      redisPointer = await this.deps.store.readPointer(timeout);
    } catch (error) {
      throw new PromotionError(`Redis or Valkey cannot be read: ${message(error, "unknown")}`);
    }
    let bucketPointer: ReplicaPointer | null;
    try {
      bucketPointer = await this.deps.replicas.readPointer();
    } catch (error) {
      throw new PromotionError(`object storage cannot be read: ${message(error, "unknown")}`);
    }
    this.notePointer(redisPointer);
    this.notePointer(bucketPointer);
    let pointer = [redisPointer, bucketPointer].filter((item): item is ReplicaPointer => item !== null).sort((a, b) => b.epoch - a.epoch)[0] ?? null;
    let fromListing = false;
    if (!pointer) {
      let ids: string[];
      try {
        ids = await this.deps.replicas.listReplicaIds();
      } catch (error) {
        throw new PromotionError(`object storage cannot be listed: ${message(error, "unknown")}`);
      }
      const newest = ids.at(-1);
      if (newest) {
        // Both pointers are gone but replicas exist: the newest term's replica is the newest database.
        pointer = { replicaId: newest, epoch: replicaEpoch(newest), nodeId: this.config.nodeId, previous: null, updatedAt: this.iso() };
        fromListing = true;
        this.epochFloor = Math.max(this.epochFloor, pointer.epoch);
      }
    }
    if (pointer && pointer.epoch >= lease.epoch) return "raise-epoch";
    this.guard();

    if (!pointer) {
      // Never set up: this node's own database becomes the first replica.
      if (!this.deps.local.exists(this.config.databasePath)) {
        throw new PromotionError(
          "the cluster has no replica yet and this node has no database to start it from: start one node without HA_ENABLED " +
            "first, then turn high availability on"
        );
      }
      return { source: "bootstrap", replicaId: null, restoredPath: null };
    }

    const restoredPath = `${this.config.haDir}/restore.db`;
    let restored: boolean;
    try {
      restored = await this.deps.litestream.restore(pointer.replicaId, restoredPath);
    } catch (error) {
      throw new PromotionError(`replica ${pointer.replicaId} could not be restored: ${message(error, "unknown")}`);
    }
    if (restored) return { source: "replica", replicaId: pointer.replicaId, restoredPath };
    if (this.config.recoverFromLocal && this.deps.local.exists(this.config.databasePath)) {
      this.log(`replica ${pointer.replicaId} is empty; HA_RECOVER_FROM_LOCAL is set, so this node's own database becomes the replica`);
      return { source: "local", replicaId: pointer.replicaId, restoredPath: null };
    }
    throw new PromotionError(
      `replica ${pointer.replicaId}${fromListing ? "" : " (the cluster's current one)"} is empty in object storage: ` +
        "see the lost bucket runbook (HA_RECOVER_FROM_LOCAL)"
    );
  }

  /** Took the lease at `requestedAt`: restore, replicate, then serve as the leader. */
  async promote(lease: LeaseRecord, requestedAt: number): Promise<void> {
    this.role = "promoting";
    this.lease = lease;
    this.keeper = new LeaseKeeper(this.deps.store, lease, requestedAt, {
      ttlMs: this.config.leaseTtlMs,
      clock: this.clock,
      onLost: (reason) => this.fence(reason),
      onRenewed: () => {
        this.leaseStatus = { ...this.leaseStatus, checkedAt: this.iso(), error: null };
        this.writeStatus();
      },
      onRenewFailed: (problem) => {
        this.leaseStatus = { ...this.leaseStatus, error: problem };
        this.writeStatus();
      },
    });
    this.keeper.start();
    this.leaseStatus = { holder: this.config.nodeId, epoch: lease.epoch, checkedAt: this.iso(), error: null };
    this.log(`took the lease (epoch ${lease.epoch}); promoting`);
    this.writeStatus();

    const startedAt = this.now();
    let plan: RestorePlan | null = null;
    try {
      await this.stopChild(this.app);
      this.app = null;
      await this.stopChild(this.follow);
      this.follow = null;
      this.guard();

      const planned = await this.planRestore(lease);
      if (planned === "raise-epoch") {
        this.log(`object storage knows a newer term than epoch ${lease.epoch}; taking the lease again above it`);
        await this.stepDown(false);
        this.promotionBlockedUntil = 0;
        return;
      }
      plan = planned;
      this.guard();

      if (plan.restoredPath) this.deps.local.install(plan.restoredPath, this.config.databasePath);
      this.deps.local.resetReplicationState(this.config.databasePath);
      this.deps.local.prepareForReplication(this.config.databasePath);
      this.guard();

      const replicaId = `e${lease.epoch}-${this.randomHex(4)}`;
      this.startReplicate(replicaId);
      await this.waitForFirstSync();
      this.guard();

      const pointer: ReplicaPointer = {
        replicaId,
        epoch: lease.epoch,
        nodeId: this.config.nodeId,
        previous: plan.replicaId,
        updatedAt: this.iso(),
      };
      if (!(await this.deps.store.writePointer(lease, pointer, this.timing.acquireIntervalMs * 2))) {
        this.fence("another node holds the lease now");
        throw new FencedError();
      }
      this.guard();
      this.pointer = pointer;
      this.pendingBucketPointer = pointer;
      await this.flushBucketPointer();

      this.lastRestore = {
        at: this.iso(),
        ok: true,
        source: plan.source,
        replicaId: plan.replicaId,
        durationMs: this.now() - startedAt,
        error: null,
      };
      this.promotionFailures = 0;
      this.role = "leader";
      // The dashboard checks the status file for its role before it starts its jobs.
      this.writeStatus();
      this.leaderSince = this.now();
      this.lastVerifyAt = this.now();
      this.pruned = false;
      this.deps.litestream.removeOtherStandbyCopies(null);
      await this.ensureApp("leader", this.config.databasePath);
      this.log(
        `leader (epoch ${lease.epoch}), replicating to ${replicaId}; ` +
          (plan.source === "replica" ? `restored from ${plan.replicaId}` : plan.source === "bootstrap" ? "set the cluster up from this node's database" : "recovered from this node's database")
      );
      this.writeStatus();
    } catch (error) {
      if (error instanceof FencedError || this.keeper?.isLost || this.stopping) return;
      const problem = message(error, "the promotion failed");
      this.lastRestore = {
        at: this.iso(),
        ok: false,
        source: plan?.source ?? null,
        replicaId: plan?.replicaId ?? null,
        durationMs: this.now() - startedAt,
        error: problem,
      };
      this.promotionFailures++;
      const delay = Math.min(this.timing.promotionBackoffMaxMs, this.timing.promotionBackoffMs * 2 ** (this.promotionFailures - 1));
      this.promotionBlockedUntil = this.now() + delay;
      this.log(`promotion failed: ${problem}; giving the lease back, next attempt in ${Math.round(delay / 1000)} s`);
      await this.stepDown(true);
    }
  }

  /** Back to standby after a promotion that did not complete: stop what started, give the lease back. */
  private async stepDown(report: boolean) {
    await this.stopChild(this.replicate);
    this.replicate = null;
    const keeper = this.keeper;
    this.keeper = null;
    this.lease = null;
    await keeper?.release();
    if (this.stopping) return;
    this.role = "standby";
    this.leaseStatus = { holder: null, epoch: null, checkedAt: this.iso(), error: this.leaseStatus.error };
    this.writeStatus();
    if (report) await this.report();
    await this.ensureStandbyProcesses();
  }

  private startReplicate(replicaId: string) {
    const handle = this.deps.litestream.startReplicate(replicaId);
    const child: ReplicateChild = { handle, exited: false, restartAt: 0, replicaId };
    this.replicate = child;
    void handle.exited.then((result) => {
      child.exited = true;
      child.restartAt = this.now() + this.timing.restartDelayMs;
      if (this.replicate === child && !this.stopping && this.role === "leader") {
        this.log(`litestream stopped (exit ${result.code ?? result.signal}); restarting it`);
      }
    });
  }

  private async waitForFirstSync() {
    const deadline = this.now() + this.timing.firstSyncTimeoutMs;
    for (;;) {
      this.guard();
      if (!this.replicate || this.replicate.exited) {
        throw new PromotionError("litestream stopped before the first copy reached object storage");
      }
      try {
        if (await this.deps.litestream.lastSyncAt()) return;
      } catch {
        // The control socket answers once litestream has started.
      }
      if (this.now() >= deadline) throw new PromotionError("the first copy did not reach object storage in time");
      await new Promise<void>((resolve) => this.clock.setTimeout(resolve, 500));
    }
  }

  private async flushBucketPointer() {
    const pointer = this.pendingBucketPointer;
    if (!pointer) return;
    try {
      await this.deps.replicas.writePointer(pointer);
      if (this.pendingBucketPointer === pointer) this.pendingBucketPointer = null;
    } catch (error) {
      this.log(`cluster.json could not be written (retrying): ${message(error, "unknown")}`);
    }
  }

  // ── Leader ──────────────────────────────────────────────────────────────

  /** One leader round: replication status, restarts, node list, checks. */
  async leaderTick(): Promise<void> {
    if (this.role !== "leader" || this.stopping || !this.lease) return;
    const replicate = this.replicate;
    if (replicate?.exited && this.now() >= replicate.restartAt) this.startReplicate(replicate.replicaId);

    if (this.replicate) {
      const previous = this.replication;
      try {
        const at = await this.deps.litestream.lastSyncAt();
        this.replication = {
          replicaId: this.replicate.replicaId,
          lastSyncAt: at ? at.toISOString() : previous?.lastSyncAt ?? null,
          lagSeconds: at ? Math.max(0, Math.round((this.now() - at.getTime()) / 1000)) : null,
          error: null,
          checkedAt: this.iso(),
        };
      } catch (error) {
        const last = previous?.lastSyncAt ?? null;
        this.replication = {
          replicaId: this.replicate.replicaId,
          lastSyncAt: last,
          lagSeconds: last ? Math.max(0, Math.round((this.now() - Date.parse(last)) / 1000)) : null,
          error: this.replicate.exited ? "litestream is not running; it is restarted shortly" : message(error, "litestream's status cannot be read"),
          checkedAt: this.iso(),
        };
      }
    }

    await this.ensureApp("leader", this.config.databasePath);
    await this.flushBucketPointer();
    await this.report();
    await this.refreshNodes();
    if (this.now() - this.lastVerifyAt >= this.timing.verifyIntervalMs) await this.verifyReplica();
    if (!this.pruned && this.now() - this.leaderSince >= this.timing.pruneDelayMs) await this.pruneReplicas();
    this.writeStatus();
  }

  private async refreshNodes() {
    try {
      const nodes = await this.deps.store.listNodes();
      const stale = nodes.filter((node) => node.id !== this.config.nodeId && this.now() - Date.parse(node.updatedAt) > this.timing.staleNodeMs);
      if (stale.length > 0) await this.deps.store.forgetNodes(stale.map((node) => node.id));
      this.nodes = nodes.filter((node) => !stale.includes(node));
    } catch {
      // Shown as last read.
    }
  }

  /**
   * A replica that Litestream has written but object storage no longer holds
   * (the bucket or the path was emptied): send a full copy again, to the same
   * replica, and write cluster.json again.
   */
  private async verifyReplica() {
    this.lastVerifyAt = this.now();
    const replicate = this.replicate;
    if (!replicate || replicate.exited || !this.replication?.lastSyncAt) return;
    let present: boolean;
    try {
      present = await this.deps.replicas.hasObjects(replicate.replicaId);
    } catch {
      return;
    }
    if (present || this.role !== "leader") return;
    this.log(`replica ${replicate.replicaId} is gone from object storage; sending a full copy again`);
    await this.stopChild(replicate, 30_000);
    if (this.role !== "leader" || this.stopping) return;
    this.deps.local.resetReplicationState(this.config.databasePath);
    this.startReplicate(replicate.replicaId);
    if (this.pointer) this.pendingBucketPointer = this.pointer;
    await this.flushBucketPointer();
  }

  /** Deletes replicas of earlier terms, keeping the current one and the one it was restored from. */
  private async pruneReplicas() {
    this.pruned = true;
    const lease = this.lease;
    if (!lease || !this.pointer) return;
    const keep = new Set([this.pointer.replicaId, ...(this.pointer.previous ? [this.pointer.previous] : [])]);
    try {
      for (const id of await this.deps.replicas.listReplicaIds()) {
        if (keep.has(id) || replicaEpoch(id) >= lease.epoch) continue;
        if (this.role !== "leader" || this.keeper?.isLost) return;
        const removed = await this.deps.replicas.deleteReplica(id);
        this.log(`deleted replica ${id} of an earlier term (${removed} objects)`);
      }
    } catch (error) {
      this.log(`old replicas could not be deleted: ${message(error, "unknown")}`);
    }
  }

  // ── Fencing and shutdown ────────────────────────────────────────────────

  /** Crash-only fencing: kill the dashboard and Litestream now, then exit so the container restarts as a standby. */
  fence(reason: string): void {
    if (this.stopping) return;
    this.stopping = true;
    this.log(`fencing: ${reason}; stopping the dashboard and Litestream and exiting`);
    this.keeper?.stop();
    if (this.timer) this.clock.clearTimeout(this.timer);
    for (const child of [this.app, this.replicate, this.follow]) child?.handle.kill("SIGKILL");
    this.role = "stopping";
    this.writeStatus();
    this.deps.exit(1);
  }

  /** Graceful stop (SIGTERM): the dashboard, then Litestream's last sync, then the lease goes back. */
  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.timer) this.clock.clearTimeout(this.timer);
    const wasLeader = this.role === "leader" || this.role === "promoting";
    this.role = "stopping";
    this.writeStatus();
    this.log(wasLeader ? "stopping: handing the lease over" : "stopping");
    await this.stopChild(this.app);
    await this.stopChild(this.follow);
    // Litestream sends what is left of the WAL when it receives SIGTERM.
    await this.stopChild(this.replicate, 30_000);
    if (this.keeper) await this.keeper.release();
    try {
      await this.deps.store.forgetNodes([this.config.nodeId], 2_000);
    } catch {
      // The leader drops stale reports.
    }
    this.deps.store.close();
    this.deps.exit(0);
  }

  // ── Children ────────────────────────────────────────────────────────────

  private async ensureApp(role: AppRole, databasePath: string | null) {
    if (this.stopping) return;
    const current = this.app;
    if (current && current.role === role && current.databasePath === databasePath && !current.exited) return;
    if (current && current.exited && current.role === role && current.databasePath === databasePath && this.now() < current.restartAt) return;
    if (current && !current.exited) await this.stopChild(current);
    if (this.stopping || (role === "leader" && this.role !== "leader") || (role === "standby" && this.role !== "standby")) return;
    const handle = this.deps.app.start(role, databasePath);
    const child: AppChild = { handle, exited: false, restartAt: 0, role, databasePath };
    this.app = child;
    void handle.exited.then((result) => {
      child.exited = true;
      child.restartAt = this.now() + this.timing.restartDelayMs;
      if (this.app === child && !this.stopping) this.log(`the dashboard stopped (exit ${result.code ?? result.signal}); restarting it`);
    });
  }

  private async stopChild(child: Child | null, timeoutMs = this.timing.stopTimeoutMs) {
    if (!child || child.exited) return;
    child.handle.kill("SIGTERM");
    let timer: TimerHandle | null = null;
    const timedOut = await Promise.race([
      child.handle.exited.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = this.clock.setTimeout(() => resolve(true), timeoutMs);
      }),
    ]);
    if (timer) this.clock.clearTimeout(timer);
    if (timedOut) {
      child.handle.kill("SIGKILL");
      await child.handle.exited;
    }
    child.exited = true;
  }

  // ── Reporting ───────────────────────────────────────────────────────────

  private followStatus(): FollowStatus | null {
    if (this.role !== "standby" || this.config.followIntervalSeconds === 0) return null;
    const replicaId = this.pointer?.replicaId ?? null;
    return {
      replicaId,
      ready: replicaId !== null && this.deps.litestream.standbyCopyReady(replicaId),
      error: this.followError,
    };
  }

  private nodeReport(): NodeReport {
    return {
      id: this.config.nodeId,
      role: this.role,
      epoch: this.lease?.epoch ?? null,
      follow: this.followStatus(),
      lastRestore: this.lastRestore,
      updatedAt: this.iso(),
    };
  }

  private async report() {
    try {
      await this.deps.store.reportNode(this.nodeReport(), this.timing.acquireIntervalMs * 2);
    } catch {
      // Reports are informational.
    }
  }

  status(): NodeStatusFile {
    const leader = this.role === "leader" || this.role === "promoting";
    return {
      version: 1,
      nodeId: this.config.nodeId,
      role: this.role,
      startedAt: this.startedAt,
      updatedAt: this.iso(),
      fenceAt: leader && this.keeper && !this.keeper.isLost ? this.iso(this.keeper.fenceAt) : null,
      lease: this.leaseStatus,
      replication: this.role === "leader" ? this.replication : null,
      follow: this.followStatus(),
      lastRestore: this.lastRestore,
      nodes: this.role === "leader" ? this.nodes : [],
    };
  }

  private writeStatus() {
    try {
      this.deps.writeStatus(this.status());
    } catch (error) {
      this.log(`the status file could not be written: ${message(error, "unknown")}`);
    }
  }
}
