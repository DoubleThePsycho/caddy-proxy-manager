// SPDX-License-Identifier: Elastic-2.0
/**
 * PostgreSQL replicas, the Enterprise part (D6; ee/docs/high-availability.md,
 * "PostgreSQL replicas"): the license rule a new replica joins under, and
 * the view Settings → High availability and GET /api/v1/cluster/nodes show.
 *
 * The rule: one replica on a PostgreSQL database is free. A node id the
 * cluster does not know may join next to a live replica only while the
 * installed license lets an administrator set up high availability (the
 * Enterprise feature, active or in its grace period). It is read once, when
 * the node joins; known replicas start and run whatever the license says
 * (src/lib/cluster-nodes.ts).
 */
import { EDITION_LABELS, FEATURE_INFO } from "@/ee/licensing/features";
import { isFeatureConfigurable } from "@/ee/licensing/store";
import {
  currentReplicaIdentity,
  listClusterNodes,
  NODE_GONE_AFTER_MS,
  NODE_HEARTBEAT_INTERVAL_MS,
  NODE_PRUNE_AFTER_MS,
} from "@/src/lib/cluster-nodes";
import { getLeaderStatus } from "@/src/lib/db/leader";
import { replicaRefusal } from "@/ee/high-availability/replica-admission";
import type { DbExecutor } from "@/src/lib/db/types";
import { HIGH_AVAILABILITY_FEATURE } from "./types";
import type { PostgresReplicasView } from "./cluster/types";

/** D6: whether a new replica may join next to a live one, by the license installed at `now`. */
export async function replicaJoinAllowed(now: Date): Promise<boolean> {
  return await isFeatureConfigurable(HIGH_AVAILABILITY_FEATURE, now);
}

/** What a refused replica logs and answers requests with. */
export function replicaRefusedMessage(): string {
  const edition = EDITION_LABELS[FEATURE_INFO[HIGH_AVAILABILITY_FEATURE].edition];
  return (
    "This replica was not admitted: another replica is already running on this PostgreSQL database, and more than one " +
    `replica needs an active ${edition} license with high availability. Install the license on a running replica; this ` +
    "one tries again every 30 seconds and joins on its own. The replicas already running are not affected."
  );
}

/** The replicas as the replica answering sees them. Reading never needs a license. */
export async function getPostgresReplicasView(options: { now?: Date; db?: DbExecutor } = {}): Promise<PostgresReplicasView> {
  const now = options.now ?? new Date();
  const identity = currentReplicaIdentity();
  const refusal = replicaRefusal();
  const election = getLeaderStatus();
  const nodes = await listClusterNodes({ now, db: options.db });
  const leaderRow = nodes.find((node) => node.leader) ?? null;
  const registered = identity !== null && nodes.some((node) => node.nodeId === identity.nodeId);
  return {
    nodeId: identity?.nodeId ?? null,
    role: refusal ? "refused" : election.leader ? "leader" : registered ? "follower" : "joining",
    refusal,
    leaderNodeId: leaderRow?.nodeId ?? null,
    election: {
      state: election.state,
      leader: election.leader,
      leaderSince: election.leaderSince,
      lastHeartbeatAt: election.lastHeartbeatAt,
      terms: election.terms,
      lastError: election.lastError,
      lastErrorAt: election.lastErrorAt,
    },
    liveReplicas: nodes.filter((node) => node.status === "live").length,
    nodes: nodes.map((node) => ({
      id: node.nodeId,
      hostname: node.hostname,
      version: node.version,
      schemaVersion: node.schemaVersion,
      firstSeenAt: node.firstSeenAt,
      startedAt: node.startedAt,
      lastHeartbeatAt: node.lastHeartbeatAt,
      stoppedAt: node.stoppedAt,
      status: node.status,
      leader: node.leader,
      leaderSince: node.leaderSince,
      thisNode: node.nodeId === identity?.nodeId,
    })),
    heartbeatSeconds: NODE_HEARTBEAT_INTERVAL_MS / 1000,
    goneAfterSeconds: NODE_GONE_AFTER_MS / 1000,
    pruneAfterDays: NODE_PRUNE_AFTER_MS / 86_400_000,
  };
}
