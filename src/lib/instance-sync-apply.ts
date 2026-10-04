/**
 * Applying a sync payload on a slave, the same way whether the master pushed
 * it (app/api/instances/sync/route.ts) or a pull replica fetched it
 * (ee/fleet/pull-agent.ts): store it (secrets opened with this instance's
 * key, see applySyncPayload), apply Caddy, record the outcome and, once Caddy
 * accepted it, what was applied for drift detection.
 */
import { applyCaddyConfig } from "./caddy";
import { applySyncPayload, setSlaveLastSync, type SyncPayload } from "./instance-sync";
import {
  SYNC_SEALED_KEY_MISMATCH_ERROR,
  SYNC_SEALED_OPEN_FAILED_ERROR,
  SYNC_SEALED_STALE_ERROR,
} from "./instance-sync-error";
import { recordAppliedSync } from "./instance-sync-status";
import { normalizeSyncPayload } from "./instance-sync-validation";
import { SyncSealError } from "./sync-crypto";

const DEFAULT_MAX_SYNC_BODY_BYTES = 10 * 1024 * 1024; // 10 MB
const parsedMaxBytes = Number(process.env.INSTANCE_SYNC_MAX_BYTES);
/** Largest sync payload a slave accepts (INSTANCE_SYNC_MAX_BYTES, default 10 MB). */
export const MAX_SYNC_BODY_BYTES = Number.isFinite(parsedMaxBytes) && parsedMaxBytes > 0
  ? parsedMaxBytes
  : DEFAULT_MAX_SYNC_BODY_BYTES;

export const SYNC_APPLY_FAILED_ERROR = "Failed to apply sync payload";

/**
 * How applying went. A failure carries the HTTP status the sync route answers
 * with (409: retry with a fresh key and nonce; 400: the sealed secrets do not
 * open; 500: storing or Caddy failed) and a fixed message.
 */
export type ReceivedSyncResult = { ok: true } | { ok: false; status: 400 | 409 | 500; error: string };

/**
 * Apply a validated payload (see syncPayloadValidationError). Nothing is
 * written when its sealed secrets do not open. The outcome is recorded as
 * this slave's last sync either way.
 */
export async function applyReceivedSyncPayload(payload: SyncPayload): Promise<ReceivedSyncResult> {
  try {
    const applied = await applySyncPayload(normalizeSyncPayload(payload));
    await applyCaddyConfig();
    await setSlaveLastSync({ ok: true });
    // Drift detection (see instance-sync-status.ts); never throws.
    await recordAppliedSync(applied);
    return { ok: true };
  } catch (error) {
    if (error instanceof SyncSealError) {
      // Nothing was written. A payload sealed to a previous key (this slave's
      // SESSION_SECRET changed after the master fetched the key) or with a
      // nonce this process no longer holds (it restarted, the nonce expired
      // or was used) gets 409: the master's next sync fetches both again.
      const retry = error.code === "key_mismatch" || error.code === "stale";
      const message = error.code === "key_mismatch"
        ? SYNC_SEALED_KEY_MISMATCH_ERROR
        : error.code === "stale" ? SYNC_SEALED_STALE_ERROR : SYNC_SEALED_OPEN_FAILED_ERROR;
      await setSlaveLastSync({ ok: false, error: message });
      return { ok: false, status: retry ? 409 : 400, error: message };
    }
    // This value is persisted and later serialized into the settings browser;
    // keep it operationally useful but independent of exception internals.
    await setSlaveLastSync({ ok: false, error: "Failed to apply synchronized configuration" });
    return { ok: false, status: 500, error: SYNC_APPLY_FAILED_ERROR };
  }
}
