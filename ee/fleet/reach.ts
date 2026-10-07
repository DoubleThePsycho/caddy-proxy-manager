// SPDX-License-Identifier: Elastic-2.0
/**
 * Which Caddy nodes a configuration change made here reaches: this node,
 * and on a master the enabled slave instances (pushed to or pulling) that
 * are not in a promotion-only environment. Instances in a promotion-only
 * environment get the change only when a revision is promoted to them.
 * Read-only.
 */
import { eq } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { fleetEnvironments, fleetInstances, instances, settings } from "@/src/lib/db/schema";
import type { InstanceMode } from "@/src/lib/instance-sync";
import { first } from "@/src/lib/db/ops";

export type ConfigurationReach = {
  mode: InstanceMode;
  /** This node plus the instances the change is synced to. */
  nodes: number;
  instances: { id: number; name: string; syncMode: "push" | "pull" }[];
  /** Instances that only take changes through promotion. */
  heldBack: { id: number; name: string; environment: string }[];
};

const MODES: readonly InstanceMode[] = ["standalone", "master", "slave"];

/** The instance mode as getInstanceMode reads it (INSTANCE_MODE first, then the stored setting). */
async function readInstanceMode(): Promise<InstanceMode> {
  const fromEnv = process.env.INSTANCE_MODE;
  if (fromEnv && (MODES as readonly string[]).includes(fromEnv)) return fromEnv as InstanceMode;
  const row = await first(appDb.select({ value: settings.value }).from(settings).where(eq(settings.key, "instance_mode")).limit(1));
  if (!row) return "standalone";
  try {
    const value = JSON.parse(row.value);
    return (MODES as readonly unknown[]).includes(value) ? (value as InstanceMode) : "standalone";
  } catch {
    return "standalone";
  }
}

export async function readConfigurationReach(): Promise<ConfigurationReach> {
  const mode = await readInstanceMode();
  if (mode !== "master") return { mode, nodes: 1, instances: [], heldBack: [] };
  const rows = await appDb
    .select({
      id: instances.id,
      name: instances.name,
      syncMode: instances.syncMode,
      environment: fleetEnvironments.name,
      promotionOnly: fleetEnvironments.promotionOnly,
    })
    .from(instances)
    .leftJoin(fleetInstances, eq(fleetInstances.instanceId, instances.id))
    .leftJoin(fleetEnvironments, eq(fleetEnvironments.id, fleetInstances.environmentId))
    .where(eq(instances.enabled, true))
    .orderBy(instances.id);
  const reached: ConfigurationReach["instances"] = [];
  const heldBack: ConfigurationReach["heldBack"] = [];
  for (const row of rows) {
    if (row.promotionOnly) heldBack.push({ id: row.id, name: row.name, environment: row.environment ?? "" });
    else reached.push({ id: row.id, name: row.name, syncMode: row.syncMode === "pull" ? "pull" : "push" });
  }
  return { mode, nodes: 1 + reached.length, instances: reached, heldBack };
}

export async function getConfigurationReach(): Promise<ConfigurationReach> {
  return await readConfigurationReach();
}
