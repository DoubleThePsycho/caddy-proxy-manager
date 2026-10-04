// SPDX-License-Identifier: Elastic-2.0
/**
 * Which monetized hosts a replica serves, as the master's allowance endpoint
 * checks it (replica-allowance.ts): a replica may only reserve requests for a
 * host whose section it was sent (replica-sync.ts).
 *
 * A replica outside a promotion-only fleet environment (and every slave in
 * INSTANCE_SLAVES) gets the master's live configuration, so it serves every
 * monetized host. One in a promotion-only environment gets its environment's
 * revisions: it serves the monetized hosts of the revision it runs, of the
 * one its environment is pinned to, of the one a running rollout or a
 * re-sync is taking it to, and of the one last delivered to it (a pull
 * replica). The answer is cached briefly per
 * replica; a host whose monetization is turned off is refused by the
 * engine's own index at once.
 */
import { and, eq } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import {
  fleetEnvironments,
  fleetInstances,
  fleetPullReplicas,
  fleetRolloutTargets,
  fleetRollouts,
  monetizationHosts,
  proxyHosts,
} from "@/src/lib/db/schema";
import { first } from "@/src/lib/db/ops";

const CACHE_MS = 30_000;

type Cached = { hostIds: Set<number>; expiresAt: number };
const cacheStore = globalThis as typeof globalThis & { __ingressiReplicaHosts?: Map<number, Cached> };
function cache(): Map<number, Cached> {
  return (cacheStore.__ingressiReplicaHosts ??= new Map());
}

async function liveMonetizedHostIds(): Promise<Set<number>> {
  const rows = await appDb
    .select({ id: monetizationHosts.proxyHostId })
    .from(monetizationHosts)
    .innerJoin(proxyHosts, eq(proxyHosts.id, monetizationHosts.proxyHostId))
    .where(eq(monetizationHosts.enabled, true));
  return new Set(rows.map((row) => row.id));
}

/** The revisions a replica in a promotion-only environment runs or is being taken to; null outside one. */
async function revisionsOf(instanceId: number): Promise<Set<number> | null> {
  const fleet = await first(appDb
    .select({
      environmentId: fleetInstances.environmentId,
      revisionId: fleetInstances.revisionId,
      promotionOnly: fleetEnvironments.promotionOnly,
      pinnedRevisionId: fleetEnvironments.revisionId,
    })
    .from(fleetInstances)
    .leftJoin(fleetEnvironments, eq(fleetEnvironments.id, fleetInstances.environmentId))
    .where(eq(fleetInstances.instanceId, instanceId))
    .limit(1));
  if (!fleet?.environmentId || !fleet.promotionOnly) return null;
  const revisions = new Set<number>();
  if (fleet.revisionId !== null) revisions.add(fleet.revisionId);
  if (fleet.pinnedRevisionId !== null) revisions.add(fleet.pinnedRevisionId);
  const targets = await appDb
    .select({ revisionId: fleetRollouts.revisionId })
    .from(fleetRolloutTargets)
    .innerJoin(fleetRollouts, eq(fleetRollouts.id, fleetRolloutTargets.rolloutId))
    .where(and(eq(fleetRolloutTargets.instanceId, instanceId), eq(fleetRollouts.status, "running")));
  for (const target of targets) revisions.add(target.revisionId);
  const pull = await first(appDb
    .select({ resync: fleetPullReplicas.resyncRevisionId, delivered: fleetPullReplicas.deliveredRevisionId })
    .from(fleetPullReplicas)
    .where(eq(fleetPullReplicas.instanceId, instanceId))
    .limit(1));
  if (pull?.resync !== null && pull?.resync !== undefined) revisions.add(pull.resync);
  if (pull?.delivered !== null && pull?.delivered !== undefined) revisions.add(pull.delivered);
  return revisions;
}

async function computeServedHostIds(instanceId: number): Promise<Set<number>> {
  const live = await liveMonetizedHostIds();
  // INSTANCE_SLAVES entries (ids below zero) always get the live configuration.
  if (instanceId < 0) return live;
  const revisions = await revisionsOf(instanceId);
  if (revisions === null) return live;
  if (revisions.size === 0) return new Set();
  const { getRevisionContent } = await import("@/ee/fleet/revisions");
  const served = new Set<number>();
  for (const revisionId of revisions) {
    const content = await getRevisionContent(revisionId).catch(() => null);
    for (const row of content?.tables.proxyHosts ?? []) {
      const id = (row as { id?: unknown }).id;
      if (typeof id === "number" && live.has(id)) served.add(id);
    }
  }
  return served;
}

/** The monetized hosts replica `instanceId` serves (see the file comment). */
export async function servedMonetizedHostIds(instanceId: number, now: number = Date.now()): Promise<Set<number>> {
  const entries = cache();
  const cached = entries.get(instanceId);
  if (cached && cached.expiresAt > now) return cached.hostIds;
  const hostIds = await computeServedHostIds(instanceId);
  if (entries.size > 10_000) entries.clear();
  entries.set(instanceId, { hostIds, expiresAt: now + CACHE_MS });
  return hostIds;
}

/** Tests only. */
export function resetServedHostsForTests(): void {
  cache().clear();
}
