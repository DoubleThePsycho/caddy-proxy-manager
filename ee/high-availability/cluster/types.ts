// SPDX-License-Identifier: Elastic-2.0
/**
 * High availability phase 2: a dashboard cluster of one leader and warm
 * standbys. Shared types: the status file the supervisor writes for the
 * dashboard process, and the cluster view the API and the High availability page show.
 * Safe to import from client components: nothing here touches Node APIs.
 */

/** "standby" waits for the lease; "promoting" holds it and restores; "leader" serves the dashboard. */
export const NODE_ROLES = ["standby", "promoting", "leader", "stopping"] as const;
export type NodeRole = (typeof NODE_ROLES)[number];

/** How the database copy of the last promotion came about. */
export type RestoreSource =
  /** The newest replica in object storage. */
  | "replica"
  /** The cluster had never been set up: this node's own database became the first replica. */
  | "bootstrap"
  /** HA_RECOVER_FROM_LOCAL: the replica was empty, so this node's own database became the replica. */
  | "local";

export type RestoreRecord = {
  at: string;
  ok: boolean;
  source: RestoreSource | null;
  /** The replica restored from, when there was one. */
  replicaId: string | null;
  durationMs: number;
  /** Why the restore failed; fixed text, never a server's words or a secret. */
  error: string | null;
};

export type ReplicationStatus = {
  /** The replica this leader writes to (a directory under the storage path). */
  replicaId: string;
  /** When Litestream last confirmed that the replica holds every local change. */
  lastSyncAt: string | null;
  /** Seconds since then, while the leader runs. */
  lagSeconds: number | null;
  /** Fixed text when Litestream is not running or its status cannot be read. */
  error: string | null;
  checkedAt: string;
};

export type FollowStatus = {
  /** The replica the warm copy follows. */
  replicaId: string | null;
  /** A copy of the database is ready for the request-path routes. */
  ready: boolean;
  error: string | null;
};

/** What a node reports about itself in the cluster's node list (in Redis or Valkey). */
export type NodeReport = {
  id: string;
  role: NodeRole;
  epoch: number | null;
  /** The warm copy, on a standby. */
  follow: FollowStatus | null;
  lastRestore: RestoreRecord | null;
  updatedAt: string;
};

/** The status file (JSON) the supervisor writes for the dashboard process of the same container. */
export type NodeStatusFile = {
  version: 1;
  nodeId: string;
  role: NodeRole;
  startedAt: string;
  updatedAt: string;
  /**
   * The leader's local deadline: after it, without a renewal, this node must
   * no longer serve the dashboard or run background jobs. Null unless leader.
   */
  fenceAt: string | null;
  lease: {
    /** Node holding the lease, as last read. */
    holder: string | null;
    /** Fencing epoch of the holder's lease. */
    epoch: number | null;
    /** When this node last renewed (leader) or read (standby) the lease. */
    checkedAt: string | null;
    /** Fixed text when Redis or Valkey could not be reached. */
    error: string | null;
  };
  replication: ReplicationStatus | null;
  follow: FollowStatus | null;
  lastRestore: RestoreRecord | null;
  /** Other nodes as they last reported themselves (leader only). */
  nodes: NodeReport[];
};

export type ClusterConfigView = {
  redis: { mode: string; addresses: string[]; keyPrefix: string; tls: boolean; hasPassword: boolean };
  storage: { endpoint: string | null; region: string; bucket: string; path: string };
  leaseTtlSeconds: number;
  syncIntervalSeconds: number;
  followIntervalSeconds: number;
};

/** A PostgreSQL replica as the cluster_nodes table shows it (src/lib/cluster-nodes.ts). */
export const REPLICA_STATUSES = ["live", "stopped", "gone"] as const;
export type ReplicaStatusName = (typeof REPLICA_STATUSES)[number];

export type ReplicaReport = {
  id: string;
  /** A label only. */
  hostname: string;
  version: string;
  /** The newest migration the replica's version knows. */
  schemaVersion: string;
  firstSeenAt: string;
  startedAt: string;
  lastHeartbeatAt: string;
  stoppedAt: string | null;
  /** live: heartbeats arrive; stopped: it stopped cleanly; gone: silent for longer than goneAfterSeconds. */
  status: ReplicaStatusName;
  /** Live and the leader as it last reported. */
  leader: boolean;
  leaderSince: string | null;
  /** The replica answering. */
  thisNode: boolean;
};

/** This process in the leader election (src/lib/db/leader.ts). */
export type ReplicaElectionView = {
  state: "off" | "connecting" | "follower" | "leader" | "stopped";
  leader: boolean;
  leaderSince: string | null;
  lastHeartbeatAt: string | null;
  terms: number;
  /** Fixed text, never the server's words. */
  lastError: string | null;
  lastErrorAt: string | null;
};

/**
 * Several web replicas on one PostgreSQL database
 * (ee/docs/high-availability.md#postgresql-replicas): every replica serves
 * requests, one leads the background jobs. Read-only.
 */
export type PostgresReplicasView = {
  /** The replica answering; null before it registered. */
  nodeId: string | null;
  /** The replica answering: leader, follower, refused (not admitted, D6) or joining (not registered yet). */
  role: "leader" | "follower" | "refused" | "joining";
  /** Why the replica answering was refused, when it was. */
  refusal: string | null;
  /** The live leader's node id, as the replicas last reported. */
  leaderNodeId: string | null;
  election: ReplicaElectionView;
  liveReplicas: number;
  nodes: ReplicaReport[];
  heartbeatSeconds: number;
  goneAfterSeconds: number;
  pruneAfterDays: number;
};

export type ClusterView = {
  /** HA_ENABLED is set on this node. */
  enabled: boolean;
  /** The license includes high availability (needed to set a cluster up; a running cluster never checks). */
  configurable: boolean;
  /** Fixed text when the configuration or the supervisor's status cannot be read. */
  error: string | null;
  node: { id: string; role: NodeRole; startedAt: string; statusUpdatedAt: string } | null;
  lease: { holder: string | null; epoch: number | null; ttlSeconds: number; checkedAt: string | null; error: string | null } | null;
  replication: ReplicationStatus | null;
  lastRestore: RestoreRecord | null;
  nodes: NodeReport[];
  config: ClusterConfigView | null;
  /** PostgreSQL mode: the replicas sharing the database (absent or null on SQLite). */
  postgres?: PostgresReplicasView | null;
};
