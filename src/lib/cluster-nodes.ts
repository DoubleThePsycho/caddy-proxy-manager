/**
 * The web replicas sharing one PostgreSQL database (ee/docs/high-availability.md,
 * "PostgreSQL replicas"): the cluster_nodes table.
 *
 * Every replica registers when it starts (joinCluster) and records a
 * heartbeat every NODE_HEARTBEAT_INTERVAL_MS, with whether it leads the
 * background jobs (src/lib/db/leader.ts). A replica silent for
 * NODE_GONE_AFTER_MS is shown as gone; the leader deletes the rows of
 * replicas silent for NODE_PRUNE_AFTER_MS. A replica that stops cleanly
 * records stoppedAt.
 *
 * Joining, the license rule (D6): a node id the table does not know joins as
 * a new replica. When another replica is live (a heartbeat within
 * NODE_GONE_AFTER_MS, not stopped), that needs a license that lets an
 * administrator set up high availability (the Enterprise high_availability
 * feature, active or in its grace period), read from the database at that
 * moment. Without it the node is refused: it is not added, it competes for
 * no lead, runs no job and serves nothing but its health check, and it tries
 * again every REPLICA_JOIN_RETRY_MS. A node id the table knows always joins,
 * whatever the license says, and a running replica never checks the license
 * again: a license that expires later changes nothing for replicas that are
 * running or restarting. A refusal changes nothing for the other replicas.
 *
 * Node ids: INGRESSI_NODE_ID, or an id generated once and kept in the data
 * volume (<INGRESSI_DATA_DIR or ./data>/node-id). The host name is a label.
 *
 * One process per node id. Every process draws a random instance token when
 * it starts and writes it with its row. Two containers on one data volume,
 * or with a copied INGRESSI_NODE_ID, would otherwise count as one replica
 * (and the second would skip the license rule): a heartbeat that finds
 * another process's token on its row, written within NODE_GONE_AFTER_MS,
 * means a duplicate. The newer process (later start, the token breaking a
 * tie) refuses to run as a replica: like a refusal under the license rule it
 * stops leading, runs no job, answers 503, says why in its log and tries
 * again every REPLICA_JOIN_RETRY_MS, joining once the other process stopped
 * or went silent. The older one writes its row back and runs on. A process
 * that starts on a row another token wrote within that time takes the row
 * over but starts no job until its next heartbeat confirms that nobody wrote
 * it meanwhile: the other process may have crashed (a container restarted
 * after a crash), which must not be mistaken for a duplicate.
 *
 * On SQLite the table exists and stays empty.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { and, eq, gte, isNull, lt, ne, or } from "drizzle-orm";
import { APP_VERSION } from "./app-version";
import { logAuditEvent } from "./audit";
import { appDb } from "./db";
import { asc, first } from "./db/ops";
import { PG_MIGRATIONS_FOLDER } from "./db/pg-startup";
import { clusterNodes } from "./db/schema";
import type { DbExecutor } from "./db/types";
import { setReplicaRefusal } from "@/ee/high-availability/replica-admission";

/** How often a replica records its heartbeat. */
export const NODE_HEARTBEAT_INTERVAL_MS = 10_000;
/** A replica without a heartbeat for this long is gone (and does not count as live when another one joins). */
export const NODE_GONE_AFTER_MS = 45_000;
/** The leader deletes replicas without a heartbeat for this long. */
export const NODE_PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** A refused replica tries to join again this often. */
export const REPLICA_JOIN_RETRY_MS = 30_000;
/** A refused replica repeats why in its log this often. */
const REFUSAL_LOG_INTERVAL_MS = 5 * 60_000;
/** The leader prunes at most this often. */
const PRUNE_INTERVAL_MS = 60 * 60_000;
/** Heartbeat failures are logged at most this often. */
const ERROR_LOG_INTERVAL_MS = 60_000;

export const NODE_ID_ENV = "INGRESSI_NODE_ID";
export const DATA_DIR_ENV = "INGRESSI_DATA_DIR";
export const NODE_ID_FILE = "node-id";
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const REPLICA_JOINED_ACTION = "ha_replica_joined";
export const REPLICA_REFUSED_ACTION = "ha_replica_refused";

/** What a replica refused as a duplicate (see the module comment) logs and answers requests with. Names no node id: the answer is public. */
export const DUPLICATE_NODE_MESSAGE =
  "This replica was not admitted: another process is already running with its node id on this PostgreSQL database " +
  "(two containers on one data volume, or the same INGRESSI_NODE_ID). Give this container its own data volume or its own " +
  "INGRESSI_NODE_ID. It tries again every 30 seconds and runs once the other process has stopped. The process already " +
  "running is not affected.";

/** INGRESSI_NODE_ID is not a valid node id; the message names the variable, not its value. */
export class NodeIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeIdError";
  }
}

export type NodeIdSource =
  /** INGRESSI_NODE_ID. */
  | "env"
  /** Read from the data volume. */
  | "file"
  /** Generated now and kept in the data volume. */
  | "generated"
  /** Generated now; the data volume could not keep it, so the next start gets another. */
  | "ephemeral";

export type NodeIdentity = {
  nodeId: string;
  source: NodeIdSource;
  /** A label only. */
  hostname: string;
  version: string;
  /** The newest migration this version knows (drizzle-pg/). */
  schemaVersion: string;
  /** When this process started. */
  startedAt: string;
  /** Drawn when this process started: tells two processes with one node id apart. Never shown. */
  instanceToken: string;
};

type Env = Readonly<Record<string, string | undefined>>;

export function dataDirectory(env: Env = process.env): string {
  return env[DATA_DIR_ENV]?.trim() || resolve(process.cwd(), "data");
}

/** This replica's node id: INGRESSI_NODE_ID, else the one kept in the data volume (generated on first use). */
export function resolveNodeId(env: Env = process.env): { nodeId: string; source: NodeIdSource } {
  const configured = env[NODE_ID_ENV]?.trim();
  if (configured) {
    if (!NODE_ID.test(configured)) {
      throw new NodeIdError(
        `${NODE_ID_ENV} must be 1 to 64 letters, digits, ".", "_" or "-", starting with a letter or a digit`
      );
    }
    return { nodeId: configured, source: "env" };
  }
  const path = join(dataDirectory(env), NODE_ID_FILE);
  let replace = false;
  try {
    const stored = readFileSync(path, "utf8").trim();
    if (NODE_ID.test(stored)) return { nodeId: stored, source: "file" };
    console.warn(`[replicas] ${path} does not hold a valid node id; this replica gets a new one`);
    replace = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[replicas] Cannot read ${path} (${(error as NodeJS.ErrnoException).code ?? "unreadable"})`);
    }
  }
  const generated = `node-${randomBytes(6).toString("hex")}`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${generated}\n`, { mode: 0o600, flag: replace ? "w" : "wx" });
    return { nodeId: generated, source: "generated" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return resolveNodeId(env);
    console.warn(
      `[replicas] Cannot keep this replica's node id in ${path} (${(error as NodeJS.ErrnoException).code ?? "unwritable"}): ` +
        `it gets a new one at every start. Set ${NODE_ID_ENV}, or give the container a data volume.`
    );
    return { nodeId: generated, source: "ephemeral" };
  }
}

/** The tag of the newest PostgreSQL migration this version knows ("unknown" without drizzle-pg/). */
export function knownSchemaVersion(migrationsFolder = PG_MIGRATIONS_FOLDER): string {
  try {
    const journal = JSON.parse(readFileSync(resolve(migrationsFolder, "meta/_journal.json"), "utf8")) as {
      entries?: Array<{ tag?: unknown }>;
    };
    const tag = journal.entries?.at(-1)?.tag;
    return typeof tag === "string" ? tag : "unknown";
  } catch {
    return "unknown";
  }
}

export function resolveNodeIdentity(env: Env = process.env, now: Date = new Date()): NodeIdentity {
  const { nodeId, source } = resolveNodeId(env);
  let hostname = "unknown";
  try {
    hostname = osHostname().slice(0, 255) || "unknown";
  } catch {
    // A label only.
  }
  return {
    nodeId,
    source,
    hostname,
    version: APP_VERSION,
    schemaVersion: knownSchemaVersion(),
    startedAt: now.toISOString(),
    instanceToken: newInstanceToken(),
  };
}

/** A random instance token (see the module comment). */
export function newInstanceToken(): string {
  return randomBytes(16).toString("base64url");
}

// ── The table ──

export type ReplicaStatus = "live" | "stopped" | "gone";

export type ClusterNode = {
  nodeId: string;
  hostname: string;
  version: string;
  schemaVersion: string;
  firstSeenAt: string;
  startedAt: string;
  lastHeartbeatAt: string;
  stoppedAt: string | null;
  status: ReplicaStatus;
  /** Live and the leader as it last reported. */
  leader: boolean;
  leaderSince: string | null;
};

/**
 * How a node joined: it was known, it was the only live replica, or the
 * license allowed another replica. `contested`: it took over a row another
 * process wrote within NODE_GONE_AFTER_MS (crashed, or a duplicate: the next
 * heartbeat tells). Refused: the license rule, or a duplicate node id.
 */
export type JoinOutcome =
  | { admitted: true; joined: "returning" | "first" | "licensed"; contested?: true }
  | { admitted: false; reason: "license" | "duplicate" };

export type JoinOptions = {
  /** D6: whether the license lets a new replica join next to a live one, read at `now`. */
  mayAddReplica: (now: Date) => Promise<boolean>;
  /**
   * When another live process wrote this node id's row: take it over (a
   * process that just started; the default) or refuse (a process already
   * refused as a duplicate, which joins once the other stopped or went silent).
   */
  whenContested?: "take-over" | "refuse";
  now?: Date;
  db?: DbExecutor;
};

/** What decides whether a row is live. */
type Liveness = { stoppedAt: string | null; lastHeartbeatAt: string };

function liveCutoff(now: Date): string {
  return new Date(now.getTime() - NODE_GONE_AFTER_MS).toISOString();
}

/**
 * A row's status at `now`: stopped cleanly, live (a heartbeat within
 * NODE_GONE_AFTER_MS) or gone. The one definition of "live": joining, the
 * duplicate check, the view and countLiveReplicas all use it (liveNodes is
 * the same in SQL).
 */
export function nodeStatus(row: Liveness, now: Date): ReplicaStatus {
  if (row.stoppedAt !== null) return "stopped";
  return row.lastHeartbeatAt < liveCutoff(now) ? "gone" : "live";
}

/** nodeStatus(row, now) === "live", as a condition on cluster_nodes. */
function liveNodes(now: Date) {
  return and(isNull(clusterNodes.stoppedAt), gte(clusterNodes.lastHeartbeatAt, liveCutoff(now)));
}

type RowOwner = Liveness & { instanceToken: string | null; startedAt: string };

/** The row was written, within the live window, by another process with this node id. */
function ownedByAnotherLiveProcess(row: RowOwner, identity: NodeIdentity, now: Date): boolean {
  return row.instanceToken !== null && row.instanceToken !== identity.instanceToken && nodeStatus(row, now) === "live";
}

/** Of two processes with one node id, `identity` started later (the token breaks a tie, the same way on both). */
function isNewerProcess(identity: NodeIdentity, row: RowOwner): boolean {
  if (identity.startedAt !== row.startedAt) return identity.startedAt > row.startedAt;
  return identity.instanceToken > (row.instanceToken ?? "");
}

const OWNER_COLUMNS = {
  instanceToken: clusterNodes.instanceToken,
  startedAt: clusterNodes.startedAt,
  stoppedAt: clusterNodes.stoppedAt,
  lastHeartbeatAt: clusterNodes.lastHeartbeatAt,
};

/**
 * Registers `identity` (see the module comment for the rule). One writing
 * transaction: on PostgreSQL it holds the write lock, so two new replicas
 * that start together are decided one after the other.
 */
export async function joinCluster(identity: NodeIdentity, options: JoinOptions): Promise<JoinOutcome> {
  const now = options.now ?? new Date();
  const at = now.toISOString();
  const db = options.db ?? appDb;
  return await db.transaction(async (tx): Promise<JoinOutcome> => {
    const fields = {
      hostname: identity.hostname,
      version: identity.version,
      schemaVersion: identity.schemaVersion,
      startedAt: identity.startedAt,
      lastHeartbeatAt: at,
      stoppedAt: null,
      leader: false,
      leaderSince: null,
      instanceToken: identity.instanceToken,
    };
    const known = await first(tx.select(OWNER_COLUMNS).from(clusterNodes).where(eq(clusterNodes.nodeId, identity.nodeId)));
    if (known) {
      const contested = ownedByAnotherLiveProcess(known, identity, now);
      if (contested && options.whenContested === "refuse") return { admitted: false, reason: "duplicate" };
      await tx.update(clusterNodes).set(fields).where(eq(clusterNodes.nodeId, identity.nodeId));
      return contested ? { admitted: true, joined: "returning", contested: true } : { admitted: true, joined: "returning" };
    }
    const live = await first(
      tx.select({ nodeId: clusterNodes.nodeId }).from(clusterNodes).where(liveNodes(now)).orderBy(asc(clusterNodes.nodeId)).limit(1)
    );
    let joined: "first" | "licensed" = "first";
    if (live) {
      if (!(await options.mayAddReplica(now))) return { admitted: false, reason: "license" };
      joined = "licensed";
    }
    await tx.insert(clusterNodes).values({ nodeId: identity.nodeId, firstSeenAt: at, ...fields });
    return { admitted: true, joined };
  });
}

/**
 * What a heartbeat found: "recorded"; "reclaimed", written over a newer
 * duplicate's token (that process stops at its own next heartbeat);
 * "duplicate", an older process with this node id is live, so nothing was
 * written and this process must stop running as a replica.
 */
export type HeartbeatOutcome = "recorded" | "reclaimed" | "duplicate";

/**
 * Records a running replica's heartbeat, unless an older live process uses
 * its node id (see the module comment). A row that is gone (pruned, deleted
 * by hand) is written again: a running replica never checks the license.
 */
export async function recordHeartbeat(
  identity: NodeIdentity,
  state: { leader: boolean; leaderSince: string | null },
  options: { now?: Date; db?: DbExecutor } = {}
): Promise<HeartbeatOutcome> {
  const now = options.now ?? new Date();
  const at = now.toISOString();
  const db = options.db ?? appDb;
  const fields = {
    hostname: identity.hostname,
    version: identity.version,
    schemaVersion: identity.schemaVersion,
    startedAt: identity.startedAt,
    lastHeartbeatAt: at,
    stoppedAt: null,
    leader: state.leader,
    leaderSince: state.leader ? state.leaderSince : null,
    instanceToken: identity.instanceToken,
  };
  return await db.transaction(async (tx): Promise<HeartbeatOutcome> => {
    const row = await first(tx.select(OWNER_COLUMNS).from(clusterNodes).where(eq(clusterNodes.nodeId, identity.nodeId)));
    let outcome: HeartbeatOutcome = "recorded";
    if (row && ownedByAnotherLiveProcess(row, identity, now)) {
      if (isNewerProcess(identity, row)) return "duplicate";
      outcome = "reclaimed";
    }
    await tx
      .insert(clusterNodes)
      .values({ nodeId: identity.nodeId, firstSeenAt: at, ...fields })
      .onConflictDoUpdate({ target: clusterNodes.nodeId, set: fields });
    return outcome;
  });
}

/** The new leader marks itself, and nobody else, as the leader (nothing when it turns out to be a duplicate). */
export async function recordLeadershipTaken(
  identity: NodeIdentity,
  leaderSince: string,
  options: { now?: Date; db?: DbExecutor } = {}
): Promise<HeartbeatOutcome> {
  const db = options.db ?? appDb;
  return await db.transaction(async (tx) => {
    const outcome = await recordHeartbeat(identity, { leader: true, leaderSince }, { now: options.now, db: tx });
    if (outcome === "duplicate") return outcome;
    await tx
      .update(clusterNodes)
      .set({ leader: false, leaderSince: null })
      .where(and(ne(clusterNodes.nodeId, identity.nodeId), eq(clusterNodes.leader, true)));
    return outcome;
  });
}

/**
 * A replica that stops cleanly: not live any more, not the leader. Only its
 * own row: when another process with its node id wrote it last, that one
 * still runs.
 */
export async function markNodeStopped(identity: NodeIdentity, options: { now?: Date; db?: DbExecutor } = {}): Promise<void> {
  const at = (options.now ?? new Date()).toISOString();
  const db = options.db ?? appDb;
  await db
    .update(clusterNodes)
    .set({ stoppedAt: at, lastHeartbeatAt: at, leader: false, leaderSince: null })
    .where(
      and(
        eq(clusterNodes.nodeId, identity.nodeId),
        or(isNull(clusterNodes.instanceToken), eq(clusterNodes.instanceToken, identity.instanceToken))
      )
    );
}

/** Deletes replicas silent for NODE_PRUNE_AFTER_MS. Returns how many. */
export async function pruneClusterNodes(options: { now?: Date; db?: DbExecutor } = {}): Promise<number> {
  const now = options.now ?? new Date();
  const db = options.db ?? appDb;
  const cutoff = new Date(now.getTime() - NODE_PRUNE_AFTER_MS).toISOString();
  const removed = await db
    .delete(clusterNodes)
    .where(lt(clusterNodes.lastHeartbeatAt, cutoff))
    .returning({ nodeId: clusterNodes.nodeId });
  return removed.length;
}

/** Every replica the table knows, first seen first, with its status at `now`. */
export async function listClusterNodes(options: { now?: Date; db?: DbExecutor } = {}): Promise<ClusterNode[]> {
  const now = options.now ?? new Date();
  const db = options.db ?? appDb;
  const rows = await db.select().from(clusterNodes).orderBy(asc(clusterNodes.firstSeenAt), asc(clusterNodes.nodeId));
  return rows.map((row) => {
    const status = nodeStatus(row, now);
    return {
      nodeId: row.nodeId,
      hostname: row.hostname,
      version: row.version,
      schemaVersion: row.schemaVersion,
      firstSeenAt: row.firstSeenAt,
      startedAt: row.startedAt,
      lastHeartbeatAt: row.lastHeartbeatAt,
      stoppedAt: row.stoppedAt,
      status,
      leader: row.leader && status === "live",
      leaderSince: row.leader && status === "live" ? row.leaderSince : null,
    };
  });
}

/**
 * How many web processes use this PostgreSQL database, this one included:
 * the live replicas, plus this process while its own row is not among them
 * (before it joined, or refused). So at least 1.
 */
export async function countLiveReplicas(options: { now?: Date; db?: DbExecutor } = {}): Promise<number> {
  const now = options.now ?? new Date();
  const db = options.db ?? appDb;
  const live = (await db.select({ nodeId: clusterNodes.nodeId }).from(clusterNodes).where(liveNodes(now))).map((row) => row.nodeId);
  const self = currentReplicaIdentity();
  return live.length + (self && live.includes(self.nodeId) ? 0 : 1);
}

// ── This process as a replica ──

type GlobalReplicaState = typeof globalThis & { __ingressiReplicaIdentity?: NodeIdentity };
const globalReplica = globalThis as GlobalReplicaState;

/** This process's identity once it has started as a PostgreSQL replica (admitted or not); null otherwise. */
export function currentReplicaIdentity(): NodeIdentity | null {
  return globalReplica.__ingressiReplicaIdentity ?? null;
}

/**
 * One attempt to join: admitted; "pending", it took over a row another
 * process wrote recently and starts nothing until a heartbeat confirms that
 * process is gone; refused; or an error (it keeps serving and tries again).
 */
export type JoinAttempt = "admitted" | "pending" | "refused" | "error";

/** Why this replica was refused: the license rule, or another process with its node id. */
export type RefusalReason = "license" | "duplicate";

export type ReplicaMembershipOptions = {
  /** Whether this replica leads now (for the heartbeat). */
  isLeader: () => boolean;
  /** D6 (default: the high_availability feature of the installed license, ee/high-availability/replicas.ts). */
  mayAddReplica?: (now: Date) => Promise<boolean>;
  /** The message a replica refused under the license rule logs and answers requests with. */
  refusalMessage?: () => Promise<string>;
  /**
   * Called each time this replica is admitted after it was not: a later
   * attempt to join, or a contested join confirmed (retryUntilAdmitted).
   * It competes for the lead from then on.
   */
  onAdmitted?: () => void;
  /**
   * Called when this running replica finds an older process with its node
   * id: it must stop leading and competing (its jobs stop); it is admitted
   * again (onAdmitted) once that process stopped.
   */
  onRefused?: () => unknown;
  heartbeatIntervalMs?: number;
  joinRetryMs?: number;
  db?: DbExecutor;
};

async function defaultMayAddReplica(now: Date): Promise<boolean> {
  const { replicaJoinAllowed } = await import("@/ee/high-availability/replicas");
  return await replicaJoinAllowed(now);
}

async function defaultRefusalMessage(): Promise<string> {
  const { replicaRefusedMessage } = await import("@/ee/high-availability/replicas");
  return replicaRefusedMessage();
}

type MembershipState =
  /** Not joined yet. */
  | "new"
  /** Took over a contested row; confirms it at the next heartbeat. */
  | "pending"
  /** A member: heartbeats, competes for the lead. */
  | "running"
  | "refused";

/**
 * This process as a member of the cluster: joining (and trying again while
 * refused), the heartbeat, the leader flag, pruning on the leader, the
 * duplicate check (see the module comment), and the clean stop.
 */
export class ReplicaMembership {
  private readonly mayAddReplica: (now: Date) => Promise<boolean>;
  private readonly refusalMessage: () => Promise<string>;
  private readonly heartbeatIntervalMs: number;
  private readonly joinRetryMs: number;
  private onAdmitted: (() => void) | undefined;
  private state: MembershipState = "new";
  private refusedFor: RefusalReason | null = null;
  private stopped = false;
  private readonly auditedRefusals = new Set<RefusalReason>();
  private lastRefusalLogAt = 0;
  private lastRefusalLogged: RefusalReason | null = null;
  private lastErrorLogAt = 0;
  private lastDuplicateWarningAt = 0;
  private lastPruneAt = 0;
  private leaderSince: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** This replica's writes, one after the other: a late heartbeat never undoes a newer leader flag or the stop. */
  private writes: Promise<void> = Promise.resolve();

  constructor(
    readonly identity: NodeIdentity,
    private readonly options: ReplicaMembershipOptions
  ) {
    this.mayAddReplica = options.mayAddReplica ?? defaultMayAddReplica;
    this.refusalMessage = options.refusalMessage ?? defaultRefusalMessage;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? NODE_HEARTBEAT_INTERVAL_MS;
    this.joinRetryMs = options.joinRetryMs ?? REPLICA_JOIN_RETRY_MS;
    this.onAdmitted = options.onAdmitted;
    globalReplica.__ingressiReplicaIdentity = identity;
  }

  /** Why this replica is refused now, or null. */
  refusal(): RefusalReason | null {
    return this.state === "refused" ? this.refusedFor : null;
  }

  /** Whether it is a member now (admitted, and not refused since). */
  isRunning(): boolean {
    return this.state === "running" && !this.stopped;
  }

  /**
   * One attempt to join. A refusal is logged and set for proxy.ts and the
   * health check (ee/high-availability/replica-admission.ts). A process refused as a duplicate
   * joins only once the other process stopped or went silent.
   */
  async join(): Promise<JoinAttempt> {
    let outcome: JoinOutcome;
    try {
      outcome = await joinCluster(this.identity, {
        mayAddReplica: this.mayAddReplica,
        whenContested: this.refusedFor === "duplicate" ? "refuse" : "take-over",
        db: this.options.db,
      });
    } catch (error) {
      // Not a refusal: the replica keeps serving and tries again.
      console.error("[replicas] This replica could not register in the cluster; it runs no background jobs until it does:", error);
      return "error";
    }
    if (!outcome.admitted) {
      await this.refuse(outcome.reason);
      return "refused";
    }
    if (outcome.contested) {
      this.state = "pending";
      console.warn(
        `[replicas] This replica's node id (${this.identity.nodeId}) was in use until a moment ago by a process that did not ` +
          `stop cleanly; it starts its background jobs once a heartbeat shows that process is gone (about ${Math.round(this.confirmAfterMs() / 1000)} s)`
      );
      return "pending";
    }
    await this.admit(outcome.joined);
    return "admitted";
  }

  /**
   * Tries to join every joinRetryMs until admitted (a pending replica
   * confirms after a heartbeat interval instead), then calls `onAdmitted`
   * (default: the option) once.
   */
  retryUntilAdmitted(onAdmitted?: () => void): void {
    if (onAdmitted) this.onAdmitted = onAdmitted;
    if (this.stopped || this.retryTimer) return;
    const pending = this.state === "pending";
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        void (pending ? this.confirm() : this.join()).then((attempt) => {
          if (this.stopped) return;
          if (attempt === "admitted") this.onAdmitted?.();
          else this.retryUntilAdmitted();
        });
      },
      pending ? this.confirmAfterMs() : this.joinRetryMs
    );
    this.retryTimer.unref?.();
  }

  /** Records a heartbeat now and every heartbeatIntervalMs. */
  startHeartbeat(): void {
    if (this.stopped || this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => void this.beat(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  /** The leader flag changes at once, not at the next heartbeat. */
  async leadershipChanged(leader: boolean): Promise<void> {
    if (this.stopped || this.state !== "running") return;
    if (!leader) {
      this.leaderSince = null;
      return await this.beat();
    }
    const leaderSince = new Date().toISOString();
    this.leaderSince = leaderSince;
    await this.write(async () => {
      if (this.state !== "running") return;
      try {
        this.heard(await recordLeadershipTaken(this.identity, leaderSince, { db: this.options.db }));
      } catch (error) {
        this.logError("Recording the new leader failed", error);
      }
    });
  }

  /** Long enough for a live process with this node id to write its heartbeat. */
  private confirmAfterMs(): number {
    return Math.round(this.heartbeatIntervalMs * 1.5);
  }

  private async admit(joined: "returning" | "first" | "licensed" | "confirmed"): Promise<void> {
    this.state = "running";
    this.refusedFor = null;
    setReplicaRefusal(null);
    const how = {
      returning: "rejoined",
      first: "joined as the only running replica",
      licensed: "joined next to running replicas",
      confirmed: "rejoined: no other process uses its node id",
    }[joined];
    console.log(`[replicas] This replica (${this.identity.nodeId}) ${how}`);
    if (joined === "first" || joined === "licensed") {
      await logAuditEvent({
        userId: null,
        action: REPLICA_JOINED_ACTION,
        entityType: "high_availability",
        summary:
          joined === "first"
            ? `Replica ${this.identity.nodeId} joined the cluster as the only running replica`
            : `Replica ${this.identity.nodeId} joined the cluster next to running replicas (license with high availability)`,
        data: { nodeId: this.identity.nodeId, hostname: this.identity.hostname, version: this.identity.version, joined },
      });
    }
  }

  private async refuse(reason: RefusalReason): Promise<void> {
    this.state = "refused";
    this.refusedFor = reason;
    this.stopHeartbeat();
    const message = reason === "license" ? await this.refusalMessage() : DUPLICATE_NODE_MESSAGE;
    setReplicaRefusal(message);
    const now = Date.now();
    if (reason !== this.lastRefusalLogged || now - this.lastRefusalLogAt >= REFUSAL_LOG_INTERVAL_MS) {
      this.lastRefusalLogged = reason;
      this.lastRefusalLogAt = now;
      console.error(`[replicas] ${message}${reason === "duplicate" ? ` Node id: ${this.identity.nodeId}.` : ""}`);
    }
    if (this.auditedRefusals.has(reason)) return;
    this.auditedRefusals.add(reason);
    await logAuditEvent({
      userId: null,
      action: REPLICA_REFUSED_ACTION,
      entityType: "high_availability",
      summary:
        reason === "license"
          ? `Replica ${this.identity.nodeId} was not admitted: another replica is running and the license does not include high availability`
          : `Replica ${this.identity.nodeId} was not admitted: another process with the same node id is running`,
      data: { nodeId: this.identity.nodeId, hostname: this.identity.hostname, version: this.identity.version, reason },
    });
  }

  /** A contested join, one heartbeat interval later: admitted unless an older process wrote the row meanwhile. */
  private async confirm(): Promise<JoinAttempt> {
    const outcome = await this.write(async () => {
      try {
        return await recordHeartbeat(this.identity, { leader: false, leaderSince: null }, { db: this.options.db });
      } catch (error) {
        this.logError("The replica heartbeat failed", error);
        return null;
      }
    });
    if (this.stopped || !outcome) return "error";
    if (outcome === "duplicate") {
      await this.refuse("duplicate");
      return "refused";
    }
    this.heard(outcome);
    await this.admit("confirmed");
    return "admitted";
  }

  /** What a heartbeat of a running replica found. */
  private heard(outcome: HeartbeatOutcome): void {
    if (outcome === "reclaimed") {
      const now = Date.now();
      if (now - this.lastDuplicateWarningAt >= REFUSAL_LOG_INTERVAL_MS) {
        this.lastDuplicateWarningAt = now;
        console.warn(
          `[replicas] Another process wrote this replica's node id (${this.identity.nodeId}): two containers share a data ` +
            "volume or INGRESSI_NODE_ID. The newer one stops serving and says so in its log; give it a node id of its own."
        );
      }
    } else if (outcome === "duplicate" && this.state === "running") {
      this.state = "refused";
      this.refusedFor = "duplicate";
      // Outside this write: stopping the lead waits for listeners that may write.
      setImmediate(() => void this.duplicateFound());
    }
  }

  /** This running replica is the newer of two processes with one node id. */
  private async duplicateFound(): Promise<void> {
    if (this.stopped) return;
    // A replica that ran until now always says why it stops.
    this.lastRefusalLogged = null;
    await this.refuse("duplicate");
    this.leaderSince = null;
    try {
      await this.options.onRefused?.();
    } catch (error) {
      console.error("[replicas] Stopping this replica's background jobs failed:", error);
    }
    this.retryUntilAdmitted();
  }

  private write<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const next = this.writes.then(() => (this.stopped ? undefined : fn()));
    this.writes = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async beat(): Promise<void> {
    await this.write(async () => {
      if (this.state !== "running") return;
      const leader = this.options.isLeader();
      try {
        const outcome = await recordHeartbeat(this.identity, { leader, leaderSince: leader ? this.leaderSince : null }, { db: this.options.db });
        this.heard(outcome);
        if (outcome !== "duplicate" && leader && Date.now() - this.lastPruneAt >= PRUNE_INTERVAL_MS) {
          this.lastPruneAt = Date.now();
          const removed = await pruneClusterNodes({ db: this.options.db });
          if (removed > 0) console.log(`[replicas] Removed ${removed} replica(s) silent for more than 30 days`);
        }
      } catch (error) {
        this.logError("The replica heartbeat failed", error);
      }
    });
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private logError(what: string, error: unknown): void {
    const now = Date.now();
    if (now - this.lastErrorLogAt < ERROR_LOG_INTERVAL_MS) return;
    this.lastErrorLogAt = now;
    console.error(`[replicas] ${what}:`, error instanceof Error ? error.message : error);
  }

  /** Stops the timers; a member records that it stopped (its own row only). */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stopHeartbeat();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    // A write already running finishes first (later ones are skipped).
    await this.writes;
    if (this.state !== "running" && this.state !== "pending") return;
    try {
      await markNodeStopped(this.identity, { db: this.options.db });
    } catch (error) {
      console.error("[replicas] Recording that this replica stopped failed:", error instanceof Error ? error.message : error);
    }
  }
}
