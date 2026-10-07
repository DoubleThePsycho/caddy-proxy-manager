/**
 * The one gate for start-up tasks, schedulers, syncs and background jobs.
 *
 * In a high availability cluster only the leader may run them: a standby
 * reads a copy of the database and must not write, push configuration to
 * Caddy or slaves, ingest logs twice or send anything twice. Every job the
 * server starts is listed in src/instrumentation.ts and started through
 * startBackgroundJobs(), which checks mayRunBackgroundJobs() once for all of
 * them; tests/unit/ha-background-jobs.test.ts checks that nothing in
 * instrumentation.ts starts work outside that list.
 *
 * PostgreSQL replicas (several web containers on one database,
 * ee/docs/high-availability.md#postgresql-replicas) all serve requests, and
 * the same jobs run on exactly one of them, the leader elected by an
 * advisory lock (src/lib/db/leader.ts). startBackgroundJobs() registers the
 * replica in the cluster (src/lib/cluster-nodes.ts; a replica refused there
 * competes for nothing), then starts the jobs whenever this replica becomes
 * the leader and stops them (their `stop` functions) as soon as it stops
 * leading. On SQLite nothing of this runs.
 *
 * A few request-path workers must run on every node, standbys included,
 * because standbys serve the request-path routes (ee/high-availability/request-path.ts).
 * They are listed separately and started with startEveryNodeJobs(); they must
 * never write to the database (a standby's copy is read-only).
 */
import { isPostgres } from "./db/dialect";
import { isLeader, type LeadershipListener } from "./db/leader";
import { getHaRole, leaderLeaseValid } from "@/ee/high-availability/role";
import { onShutdown } from "./shutdown";

export type BackgroundJob = {
  /** For logs. */
  name: string;
  start: () => unknown;
  /**
   * Stops what start() started (timers, workers), so start() can run again
   * later. A PostgreSQL replica calls it when it stops leading. One-off
   * start-up work has none.
   */
  stop?: () => unknown;
  /** Not started under NODE_ENV=test. */
  skipInTests?: boolean;
  /** A failure stops the server from starting (the error is thrown on). */
  critical?: boolean;
};

/** The jobs follow the PostgreSQL leader election (not a high availability cluster's lease). */
function followsReplicaElection(): boolean {
  return getHaRole() === "standalone" && isPostgres();
}

/**
 * A standalone dashboard on SQLite, the leader of a cluster whose lease is
 * still valid, or the PostgreSQL replica that leads.
 */
export function mayRunBackgroundJobs(now: number = Date.now()): boolean {
  const role = getHaRole();
  if (role === "standby") return false;
  if (role === "leader") return leaderLeaseValid(now);
  if (isPostgres()) return isLeader();
  return true;
}

/**
 * Starts the jobs in order when this node may run them; one that fails to
 * start is logged and the others still start, unless it is critical.
 * Returns the names started.
 *
 * On PostgreSQL: joins the cluster and the leader election (see the module
 * comment). When this replica leads at once, the jobs of that first term
 * are started before this returns, and a critical one that fails is thrown
 * on, as on SQLite; otherwise it returns [] and the jobs start whenever this
 * replica becomes the leader.
 */
export async function startBackgroundJobs(jobs: readonly BackgroundJob[]): Promise<string[]> {
  if (followsReplicaElection()) return await startReplicaJobs(jobs);
  if (!mayRunBackgroundJobs()) {
    console.log(`High availability: this node is not the leader; ${jobs.length} start-up tasks and background jobs are left to the leader`);
    return [];
  }
  const started: string[] = [];
  for (const job of jobs) {
    if (job.skipInTests && process.env.NODE_ENV === "test") continue;
    try {
      await job.start();
      started.push(job.name);
    } catch (error) {
      if (job.critical) throw error;
      console.error(`Failed to start ${job.name}:`, error);
    }
  }
  return started;
}

/**
 * Starts jobs that run on every node, standbys included (request-path
 * workers that never write to the database). A failure is logged and the
 * others still start. Returns the names started.
 */
export async function startEveryNodeJobs(jobs: readonly BackgroundJob[]): Promise<string[]> {
  const started: string[] = [];
  for (const job of jobs) {
    if (job.skipInTests && process.env.NODE_ENV === "test") continue;
    try {
      await job.start();
      started.push(job.name);
    } catch (error) {
      if (job.critical) throw error;
      console.error(`Failed to start ${job.name}:`, error);
    }
  }
  return started;
}

// ── PostgreSQL replicas ──

/** What the leader-only jobs follow: the process's elector (src/lib/db/leader.ts), or a test double. */
export interface Leadership {
  isLeader(): boolean;
  onLeadershipChange(listener: LeadershipListener): () => void;
  stepDown(reason: string, holdOffMs: number): Promise<void>;
}

/** A leader whose critical start-up task failed gives the lead up for this long, doubling each time up to an hour. */
export const CRITICAL_FAILURE_HOLD_OFF_MS = 60_000;
const MAX_CRITICAL_FAILURE_HOLD_OFF_MS = 60 * 60_000;

async function stopJob(job: BackgroundJob): Promise<void> {
  if (!job.stop) return;
  try {
    await job.stop();
  } catch (error) {
    console.error(`Failed to stop ${job.name}:`, error);
  }
}

/**
 * The jobs of a PostgreSQL replica: started in order each time it becomes
 * the leader (a term), stopped as soon as it stops leading. A job whose start
 * was still running when the lead was lost is stopped as soon as it started.
 * A critical job that fails stops the term's jobs and gives the lead up for
 * a while, so another replica can try.
 */
export class LeaderOnlyJobs {
  private term = 0;
  private running: BackgroundJob[] = [];
  private latest: Promise<string[]> | null = null;
  private criticalFailures = 0;
  private detach: (() => void) | null = null;

  constructor(
    private readonly jobs: readonly BackgroundJob[],
    private readonly leadership: Leadership
  ) {}

  /** Follows the leadership from now on. */
  attach(): void {
    this.detach ??= this.leadership.onLeadershipChange((leader) => (leader ? this.begin() : this.end()));
  }

  /**
   * The start of the latest term (null before the first): its job names
   * once every job has started; rejected when a critical one failed. Kept
   * after the term ended, so start-up sees how its first term went.
   */
  latestTerm(): Promise<string[]> | null {
    return this.latest;
  }

  /** The names of the jobs running now, in start order. */
  runningJobs(): string[] {
    return this.running.map((job) => job.name);
  }

  /** Stops following the leadership and stops every running job. */
  async close(): Promise<void> {
    this.detach?.();
    this.detach = null;
    await this.end();
  }

  private begin(): void {
    const term = ++this.term;
    const starting = this.startTerm(term);
    // Awaited by start-up for the first term; logged in startTerm otherwise.
    starting.catch(() => undefined);
    this.latest = starting;
  }

  private async end(): Promise<void> {
    this.term += 1;
    const jobs = this.running.reverse();
    this.running = [];
    await Promise.all(jobs.map((job) => stopJob(job)));
  }

  private async startTerm(term: number): Promise<string[]> {
    const started: string[] = [];
    for (const job of this.jobs) {
      if (term !== this.term) break;
      if (job.skipInTests && process.env.NODE_ENV === "test") continue;
      try {
        await job.start();
      } catch (error) {
        if (term !== this.term) break;
        if (!job.critical) {
          console.error(`Failed to start ${job.name}:`, error);
          continue;
        }
        this.criticalFailures += 1;
        const holdOffMs = Math.min(CRITICAL_FAILURE_HOLD_OFF_MS * 2 ** (this.criticalFailures - 1), MAX_CRITICAL_FAILURE_HOLD_OFF_MS);
        console.error(
          `PostgreSQL replicas: ${job.name} failed on the leader; it stops its background jobs and lets another replica lead ` +
            `for ${Math.round(holdOffMs / 1000)} s:`,
          error
        );
        await this.end();
        void this.leadership.stepDown(`${job.name} failed`, holdOffMs);
        throw error;
      }
      if (term !== this.term) {
        // The lead was lost while this job started: it must not keep running.
        await stopJob(job);
        break;
      }
      this.running.push(job);
      started.push(job.name);
    }
    if (term === this.term) this.criticalFailures = 0;
    return started;
  }
}

type ReplicaRuntime = { stop: () => Promise<void> };
type GlobalReplicaRuntime = typeof globalThis & {
  __ingressiReplicaRuntime?: ReplicaRuntime;
};
const runtimeStore = globalThis as GlobalReplicaRuntime;

/**
 * Stops this process as a PostgreSQL replica: its jobs, then the lead (the
 * lock is released, so another replica takes over within seconds), then its
 * heartbeat; it records that it stopped. Runs on SIGTERM and SIGINT. Does
 * nothing on SQLite.
 */
export async function stopBackgroundJobs(): Promise<void> {
  const runtime = runtimeStore.__ingressiReplicaRuntime;
  runtimeStore.__ingressiReplicaRuntime = undefined;
  await runtime?.stop();
}

/**
 * On SIGTERM and SIGINT, and the process waits for it (src/lib/shutdown.ts):
 * a replica that exits before it records that it stopped stays "live" for
 * NODE_GONE_AFTER_MS, and a replacement started meanwhile with its node id
 * waits for a heartbeat before it runs any job.
 */
function stopOnShutdown(): void {
  onShutdown("stopping the PostgreSQL replica", async () => {
    try {
      await stopBackgroundJobs();
    } catch (error) {
      console.error("PostgreSQL replicas: stopping failed:", error);
    }
  });
}

async function startReplicaJobs(jobs: readonly BackgroundJob[]): Promise<string[]> {
  // A runtime started earlier in this process (tests start the server more than once).
  await stopBackgroundJobs();
  const [{ ReplicaMembership, resolveNodeIdentity }, { getLeaderElector, stopLeaderElection }] = await Promise.all([
    import("./cluster-nodes"),
    import("./db/leader"),
  ]);
  const elector = getLeaderElector();
  const membership = new ReplicaMembership(resolveNodeIdentity(), {
    isLeader: () => elector.isLeader(),
    // Admitted later (after a refusal, or once a heartbeat showed that no
    // other process uses its node id): it competes for the lead from then on.
    onAdmitted: () => {
      elect().catch((error: unknown) => console.error("PostgreSQL replicas: starting the background jobs failed:", error));
    },
    // An older process runs with the same node id: this one stops leading
    // and competing (its jobs stop) until it is admitted again.
    onRefused: () => elector.stop(),
  });
  const leaderJobs = new LeaderOnlyJobs(jobs, elector);
  let unfollow: (() => void) | null = null;
  runtimeStore.__ingressiReplicaRuntime = {
    async stop() {
      // The jobs stop through the election's listeners before the lock goes.
      await stopLeaderElection();
      unfollow?.();
      await leaderJobs.close();
      await membership.stop();
    },
  };
  stopOnShutdown();

  const elect = async (): Promise<string[]> => {
    leaderJobs.attach();
    unfollow ??= elector.onLeadershipChange((leader) => membership.leadershipChanged(leader));
    membership.startHeartbeat();
    const before = leaderJobs.latestTerm();
    await elector.start();
    // A term began during the first attempt: this replica leads at once.
    const firstTerm = leaderJobs.latestTerm();
    if (!firstTerm || firstTerm === before) {
      console.log(
        "PostgreSQL replicas: this replica serves requests; another one runs the background jobs, or the election is not decided yet"
      );
      return [];
    }
    return await firstTerm;
  };

  // Refused, pending (it took over the row of a process that may have
  // crashed) or not registered yet: the membership keeps trying and calls
  // onAdmitted.
  if ((await membership.join()) !== "admitted") {
    membership.retryUntilAdmitted();
    return [];
  }
  try {
    return await elect();
  } catch (error) {
    // A critical start-up task failed on the first leader: as on SQLite,
    // the server does not start.
    await stopBackgroundJobs();
    throw error;
  }
}
