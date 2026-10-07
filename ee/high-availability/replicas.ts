// SPDX-License-Identifier: Elastic-2.0
/**
 * PostgreSQL replicas (ee/docs/high-availability.md, "PostgreSQL replicas"):
 * the view the High availability page and GET /api/v1/cluster/nodes show.
 * Joining is src/lib/cluster-nodes.ts.
 */
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
import type { PostgresReplicasView } from "./cluster/types";

/** The replicas as the replica answering sees them. */
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
