// SPDX-License-Identifier: Elastic-2.0
/**
 * Records in the audit log that this node became the leader of the
 * dashboard cluster, and how its database came about (restored from the
 * newest replica, or the cluster set up from it). Runs once when the leader's
 * dashboard starts, as one of its start-up jobs (src/instrumentation.ts); a
 * failover therefore always leaves a trace. With PostgreSQL replicas it runs
 * each time a replica becomes the leader of the background jobs. Without
 * either it does nothing.
 */
import { logAuditEvent } from "@/src/lib/audit";
import { currentReplicaIdentity } from "@/src/lib/cluster-nodes";
import { isPostgres } from "@/src/lib/db/dialect";
import { getLeaderStatus } from "@/src/lib/db/leader";
import { getHaRole } from "@/ee/high-availability/role";
import { HA_STATUS_FILE_ENV } from "./config";
import { readStatusFile } from "./status";

export const LEADER_STARTED_ACTION = "ha_leader_started";

const SOURCES = {
  replica: "restored from the newest replica",
  bootstrap: "set the cluster up from this node's database",
  local: "recovered from this node's own database",
} as const;

/** A PostgreSQL replica became the leader of the background jobs. */
async function recordReplicaLeadership(): Promise<boolean> {
  const election = getLeaderStatus();
  const identity = currentReplicaIdentity();
  if (!election.leader || !identity) return false;
  await logAuditEvent({
    userId: null,
    action: LEADER_STARTED_ACTION,
    entityType: "high_availability",
    summary: `Replica ${identity.nodeId} became the leader of the PostgreSQL replicas and runs the background jobs`,
    data: { nodeId: identity.nodeId, hostname: identity.hostname, version: identity.version, dialect: "postgres" },
  });
  return true;
}

export async function recordLeadership(env: Record<string, string | undefined> = process.env): Promise<boolean> {
  if (getHaRole() === "standalone" && isPostgres(env)) return await recordReplicaLeadership();
  if (getHaRole() !== "leader") return false;
  const path = env[HA_STATUS_FILE_ENV];
  const status = path ? readStatusFile(path) : null;
  if (!status || status.role !== "leader") return false;
  const restore = status.lastRestore;
  const how = restore?.ok && restore.source ? `: ${SOURCES[restore.source]}${restore.replicaId ? ` (${restore.replicaId})` : ""}` : "";
  await logAuditEvent({
    userId: null,
    action: LEADER_STARTED_ACTION,
    entityType: "high_availability",
    summary: `Node ${status.nodeId} became the leader of the dashboard cluster (epoch ${status.lease?.epoch ?? "unknown"})${how}`,
    data: {
      nodeId: status.nodeId,
      epoch: status.lease?.epoch ?? null,
      source: restore?.source ?? null,
      restoredFrom: restore?.replicaId ?? null,
      restoreMs: restore?.durationMs ?? null,
      replica: status.replication?.replicaId ?? null,
    },
  });
  return true;
}
