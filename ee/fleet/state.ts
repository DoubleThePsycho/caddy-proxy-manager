// SPDX-License-Identifier: Elastic-2.0
/**
 * The fleet bookkeeping that instance sync (src/lib/instance-sync.ts) and
 * instance deletion (src/lib/models/instances.ts) call.
 */
import { and, eq } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { fleetEnvironments, fleetInstances, fleetPullReplicas, fleetRolloutTargets } from "@/src/lib/db/schema";

/**
 * Instances in a promotion-only environment. A plain sync (every change,
 * "Sync now", the periodic sync) skips them: they receive configuration
 * through rollouts and re-syncs only.
 */
export async function listPinnedInstanceIds(): Promise<Set<number>> {
  const rows = await appDb
    .select({ id: fleetInstances.instanceId })
    .from(fleetInstances)
    .innerJoin(fleetEnvironments, eq(fleetEnvironments.id, fleetInstances.environmentId))
    .where(eq(fleetEnvironments.promotionOnly, true));
  return new Set(rows.map((row) => row.id));
}

export type FleetPush = {
  /** The fleet revision pushed; null for the master's live configuration. */
  revisionId: number | null;
  /** Sync fingerprint of the pushed content for this instance's token. */
  fingerprint: string;
  /** The slave answered like an older release (no sync key endpoint) and cannot report its status. */
  legacy: boolean;
};

/**
 * Record a successful push. The slave stored exactly what was pushed, so an
 * earlier drift is gone: the instance counts as in sync until the next check
 * says otherwise (a slave from an older release stays "older version").
 */
export async function recordFleetPush(instanceId: number, push: FleetPush): Promise<void> {
  const at = nowIso();
  const [existing] = await appDb
    .select({ driftStatus: fleetInstances.driftStatus })
    .from(fleetInstances)
    .where(eq(fleetInstances.instanceId, instanceId))
    .limit(1);
  const driftStatus = push.legacy || existing?.driftStatus === "older_version" ? "older_version" : "in_sync";
  const values = {
    revisionId: push.revisionId,
    pushedFingerprint: push.fingerprint,
    pushedAt: at,
    driftStatus,
    driftSince: null,
    driftDetail: null,
    localChanges: null,
    updatedAt: at,
  };
  await appDb
    .insert(fleetInstances)
    .values({ instanceId, ...values })
    .onConflictDoUpdate({ target: fleetInstances.instanceId, set: values });
}

/**
 * Forget a deleted instance: its fleet row, its pull replica row (credential
 * and reports), and the rollout targets still waiting for it (foreign-key
 * cascades are not enforced).
 */
export async function forgetFleetInstance(instanceId: number): Promise<void> {
  await appDb.delete(fleetInstances).where(eq(fleetInstances.instanceId, instanceId));
  await appDb.delete(fleetPullReplicas).where(eq(fleetPullReplicas.instanceId, instanceId));
  await appDb
    .update(fleetRolloutTargets)
    .set({ status: "skipped", error: "The instance was deleted" })
    .where(and(eq(fleetRolloutTargets.instanceId, instanceId), eq(fleetRolloutTargets.status, "pending")));
}
