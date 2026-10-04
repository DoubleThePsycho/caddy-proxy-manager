export const GENERIC_INSTANCE_SYNC_ERROR = "Previous synchronization failed";
export const SYNC_TIMED_OUT_ERROR = "Sync timed out";
export const SYNC_NOT_ACKNOWLEDGED_ERROR = "Slave did not acknowledge the sync (unexpected response)";
export const SYNC_INVALID_KEY_ERROR = "Slave returned an invalid sync key";
export const SYNC_KEY_CHANGED_ERROR = "Slave sync key changed; verify the slave, then pin its new key or reset its key pin";
export const SYNC_KEY_CONFIG_MISMATCH_ERROR = "Slave sync key does not match the key configured in INSTANCE_SLAVES";
export const SYNC_SLAVE_CHANGED_DURING_SYNC_ERROR = "Slave instance was removed or its base URL changed during the sync";
export const SYNC_SEALED_KEY_MISMATCH_ERROR = "Sync payload was sealed for a different key; retry";
export const SYNC_SEALED_STALE_ERROR = "Sync payload was sealed for an expired or already used key request; retry";
export const SYNC_SEALED_OPEN_FAILED_ERROR = "Sealed secrets in the sync payload could not be opened";
/** A pull replica runs what it was sent, but its Caddy did not accept it (see ee/fleet/pull-server.ts). */
export const SYNC_REPLICA_CADDY_FAILED_ERROR = "The replica's Caddy did not apply the configuration";
/** A pull replica's configuration could not be prepared on the master (a revision gone or unreadable). */
export const SYNC_PULL_UNAVAILABLE_ERROR = "The configuration for this replica could not be prepared on the master";

const SAFE_SYNC_ERRORS = new Set([
  "Stored token could not be decrypted",
  "Stored instance sync token does not meet the current security policy",
  "HTTP sync blocked. Set INSTANCE_SYNC_ALLOW_HTTP=true to allow insecure sync.",
  "Sync request failed",
  SYNC_TIMED_OUT_ERROR,
  SYNC_NOT_ACKNOWLEDGED_ERROR,
  SYNC_INVALID_KEY_ERROR,
  SYNC_KEY_CHANGED_ERROR,
  SYNC_KEY_CONFIG_MISMATCH_ERROR,
  SYNC_SLAVE_CHANGED_DURING_SYNC_ERROR,
  SYNC_SEALED_KEY_MISMATCH_ERROR,
  SYNC_SEALED_STALE_ERROR,
  SYNC_SEALED_OPEN_FAILED_ERROR,
  SYNC_REPLICA_CADDY_FAILED_ERROR,
  SYNC_PULL_UNAVAILABLE_ERROR,
  "Failed to apply synchronized configuration",
]);

/**
 * Older releases stored raw remote response bodies and exception messages.
 * Only allow current fixed operational statuses to cross API/browser reads.
 */
export function sanitizeInstanceSyncError(error: string | null | undefined): string | null {
  if (!error) return null;
  if (SAFE_SYNC_ERRORS.has(error) || /^Sync (?:key request )?failed with HTTP [1-5][0-9]{2}$/.test(error)) {
    return error;
  }
  return GENERIC_INSTANCE_SYNC_ERROR;
}
