/**
 * The single-use nonces sealed sync payloads are bound to (sync-crypto.ts),
 * across web replicas.
 *
 * An instance hands out a nonce with its sync key (GET /api/instances/sync
 * on a pushed slave, every poll of a pull replica) and accepts one payload
 * sealed to it, once. With several replicas on one PostgreSQL database the
 * key request and the push may reach different replicas, so there the
 * nonces live in the shared runtime state (src/lib/shared-runtime-state.ts):
 * shareSyncNonce() records a nonce this process issued, and useSyncNonce()
 * uses one up in one statement, so a payload is accepted once in the whole
 * cluster. On SQLite (one process) the nonces stay in sync-crypto.ts's
 * memory, as before.
 */
import { isPostgres } from "./db/dialect";
import { defineRuntimeEntries } from "./shared-runtime-state";
import { consumeSyncNonce, isSyncNonce, SYNC_NONCE_TTL_MS } from "./sync-crypto";

const sharedNonces = defineRuntimeEntries<true>("sync-nonce", {
  maxEntries: 100,
  isValue: (value): value is true => value === true,
  store: "database",
});

/** After issuing `nonce` (createSyncKeyResponse): on PostgreSQL, lets any replica accept the payload sealed to it. */
export async function shareSyncNonce(nonce: string): Promise<void> {
  if (isPostgres() && isSyncNonce(nonce)) await sharedNonces.put(nonce, true, SYNC_NONCE_TTL_MS);
}

/**
 * Uses up `nonce`: true when it was issued (by this process on SQLite, by
 * any replica on PostgreSQL), has not expired and was not used before.
 */
export async function useSyncNonce(nonce: string): Promise<boolean> {
  if (!isSyncNonce(nonce)) return false;
  // This process's copy goes either way.
  const local = consumeSyncNonce(nonce);
  if (!isPostgres()) return local;
  return (await sharedNonces.take(nonce)) === true;
}
