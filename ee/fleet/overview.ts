// SPDX-License-Identifier: Elastic-2.0
/**
 * Everything the Fleet page shows, in one read. Holds no secrets: revisions
 * are listed without their content, pull replicas without credentials, and
 * certificate storage as its backend only.
 */
import { inArray, sql } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { fleetRevisions } from "@/src/lib/db/schema";
import { getInstanceMode } from "@/src/lib/instance-sync";
import { getEffectiveSetting } from "@/src/lib/settings";
import { APP_VERSION } from "@/src/lib/app-version";
import { listEnvironments, listFleetInstances } from "./environments";
import { listPullReplicas } from "./pull-replicas";
import { listRevisions } from "./revisions";
import { listRollouts } from "./rollouts";
import { DRIFT_CHECK_INTERVAL_MS, ROLLOUT_TICK_INTERVAL_MS } from "./scheduler";
import type { CertificateStorageSummary, EnvironmentView, FleetInstanceView, FleetOverview, RolloutView } from "./types";
import { jsonTextAt } from "@/src/lib/db/ops";

const REVISIONS_SHOWN = 50;
const ROLLOUTS_SHOWN = 25;

const REDIS_MODES = new Set(["standalone", "cluster", "sentinel"]);

/** The backend and Redis mode of a stored certificate storage setting; anything unreadable counts as local. */
export function summarizeCertificateStorage(backend: unknown, redisMode: unknown): CertificateStorageSummary {
  if (backend !== "redis") return { backend: "local", redisMode: null };
  return {
    backend: "redis",
    redisMode: typeof redisMode === "string" && REDIS_MODES.has(redisMode) ? (redisMode as CertificateStorageSummary["redisMode"]) : null,
  };
}

async function masterCertificateStorage(): Promise<CertificateStorageSummary> {
  const value = await getEffectiveSetting<unknown>("certificate_storage").catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return summarizeCertificateStorage(null, null);
  const record = value as Record<string, unknown>;
  const redis = record.redis && typeof record.redis === "object" ? (record.redis as Record<string, unknown>) : null;
  return summarizeCertificateStorage(record.backend, redis?.mode);
}

/** Revisions the page shows a node or an environment on. */
function referencedRevisionIds(environments: EnvironmentView[], instances: FleetInstanceView[], rollouts: RolloutView[]): number[] {
  const ids = new Set<number>();
  for (const environment of environments) if (environment.revisionId !== null) ids.add(environment.revisionId);
  for (const instance of instances) if (instance.revisionId !== null) ids.add(instance.revisionId);
  for (const rollout of rollouts) {
    if (rollout.status !== "running") continue;
    ids.add(rollout.revisionId);
    if (rollout.fromRevisionId !== null) ids.add(rollout.fromRevisionId);
  }
  return [...ids];
}

/**
 * The certificate storage each revision sets. SQLite reads the two fields
 * out of the stored JSON, so no revision is loaded or decrypted.
 */
async function revisionCertificateStorage(ids: number[]): Promise<Record<string, CertificateStorageSummary>> {
  if (ids.length === 0) return {};
  const rows = await appDb
    .select({
      id: fleetRevisions.id,
      backend: sql<string | null>`${jsonTextAt(fleetRevisions.content, ["settings", "certificate_storage", "backend"])}`,
      redisMode: sql<string | null>`${jsonTextAt(fleetRevisions.content, ["settings", "certificate_storage", "redis", "mode"])}`,
    })
    .from(fleetRevisions)
    .where(inArray(fleetRevisions.id, ids));
  return Object.fromEntries(rows.map((row) => [String(row.id), summarizeCertificateStorage(row.backend, row.redisMode)]));
}

export async function getFleetOverview(): Promise<FleetOverview> {
  const [mode, environments, instances, revisions, rollouts, pullReplicas, certificateStorage] = await Promise.all([
    getInstanceMode(),
    listEnvironments(),
    listFleetInstances(),
    listRevisions({ limit: REVISIONS_SHOWN }),
    listRollouts({ limit: ROLLOUTS_SHOWN }),
    listPullReplicas(),
    masterCertificateStorage(),
  ]);
  const revisionStorage = await revisionCertificateStorage(referencedRevisionIds(environments, instances, rollouts.rollouts));
  return {
    mode,
    master: {
      version: APP_VERSION,
      certificateStorage,
      driftCheckIntervalSeconds: Math.round(DRIFT_CHECK_INTERVAL_MS / 1000),
      rolloutStepSeconds: Math.round(ROLLOUT_TICK_INTERVAL_MS / 1000),
    },
    environments,
    instances,
    revisions: revisions.revisions,
    rollouts: rollouts.rollouts,
    pullReplicas,
    revisionStorage,
  };
}
