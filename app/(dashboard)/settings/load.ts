import { getSetting } from "@/src/lib/settings";
import { getInstanceMode } from "@/src/lib/instance-sync";

/**
 * Whether this instance is a sync replica and, on a replica, which of the
 * given settings it overrides (stored on the replica) instead of following
 * its master. `keys` maps a name to the stored setting key.
 */
export async function loadReplicaOverrides<K extends string>(
  keys: Record<K, string>
): Promise<{ isSlave: boolean; overrides: Record<K, boolean> }> {
  const isSlave = (await getInstanceMode()) === "slave";
  const names = Object.keys(keys) as K[];
  const stored = isSlave ? await Promise.all(names.map((name) => getSetting(keys[name]))) : names.map(() => null);
  const overrides = Object.fromEntries(names.map((name, index) => [name, stored[index] !== null])) as Record<K, boolean>;
  return { isSlave, overrides };
}
