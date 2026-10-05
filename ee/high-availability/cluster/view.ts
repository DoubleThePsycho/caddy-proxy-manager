// SPDX-License-Identifier: Elastic-2.0
/**
 * The dashboard cluster as this dashboard process sees it, for
 * GET /api/v1/high-availability/cluster and the High availability page:
 * the configuration from the environment (without secrets) and the status
 * the supervisor of this container last wrote. Only the leader serves the
 * dashboard and the API, so this is the leader's view; reading it never
 * needs a license. On PostgreSQL (where HA_ENABLED is refused) `postgres`
 * holds the replicas sharing the database instead (../replicas.ts).
 */
import { isFeatureConfigurable } from "@/ee/licensing/store";
import { isPostgres } from "@/src/lib/db/dialect";
import { getPostgresReplicasView } from "../replicas";
import { HIGH_AVAILABILITY_FEATURE } from "../types";
import { HA_STATUS_FILE_ENV, HaConfigError, isHaEnabled, parseHaConfig, toClusterConfigView, type HaConfig } from "./config";
import { readStatusFile } from "./status";
import type { ClusterView } from "./types";

/** A status older than this means the supervisor stopped updating it. */
const STALE_STATUS_MS = 60_000;

export async function getClusterView(env: Record<string, string | undefined> = process.env, now = Date.now()): Promise<ClusterView> {
  const configurable = await isFeatureConfigurable(HIGH_AVAILABILITY_FEATURE);
  if (!isHaEnabled(env)) {
    const postgres = isPostgres(env) ? await getPostgresReplicasView({ now: new Date(now) }) : null;
    return { enabled: false, configurable, error: null, node: null, lease: null, replication: null, lastRestore: null, nodes: [], config: null, postgres };
  }
  let config: HaConfig | null = null;
  let error: string | null = null;
  try {
    config = parseHaConfig(env);
  } catch (problem) {
    error = problem instanceof HaConfigError ? problem.message : "The high availability configuration cannot be read";
  }
  const statusPath = env[HA_STATUS_FILE_ENV];
  const status = statusPath ? readStatusFile(statusPath) : null;
  if (!status) {
    error ??= "The cluster supervisor's status cannot be read: start the container with the image's entrypoint";
  } else if (now - Date.parse(status.updatedAt) > STALE_STATUS_MS) {
    error ??= `The cluster supervisor has not updated its status since ${status.updatedAt}`;
  }
  return {
    enabled: true,
    configurable,
    error,
    node: status ? { id: status.nodeId, role: status.role, startedAt: status.startedAt, statusUpdatedAt: status.updatedAt } : null,
    lease: status
      ? {
          holder: status.lease.holder,
          epoch: status.lease.epoch,
          ttlSeconds: config ? config.leaseTtlMs / 1000 : 0,
          checkedAt: status.lease.checkedAt,
          error: status.lease.error,
        }
      : null,
    replication: status?.replication ?? null,
    lastRestore: status?.lastRestore ?? null,
    nodes: status?.nodes ?? [],
    config: config ? toClusterConfigView(config) : null,
  };
}
