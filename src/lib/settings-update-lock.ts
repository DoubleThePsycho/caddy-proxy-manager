import { withClusterLock } from "./db/locks";

/** The cluster lock (src/lib/db/locks.ts) that settings updates take. */
export const SETTINGS_UPDATE_LOCK = "settings-update";

/**
 * Caddy configuration is generated from all settings at once. Serialize the
 * save/apply/rollback transaction so a failed request cannot restore stale
 * state over a concurrent successful update: on every replica of the
 * deployment (withClusterLock), first in, first out. Take it outside
 * database transactions; it is re-entrant within the async context that
 * holds it.
 */
export async function withSettingsUpdateLock<T>(
  operation: () => Promise<T>
): Promise<T> {
  return await withClusterLock(SETTINGS_UPDATE_LOCK, operation);
}
