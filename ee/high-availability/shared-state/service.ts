// SPDX-License-Identifier: Elastic-2.0
/**
 * High availability, phase 3: the shared state switch, its status, and the
 * guard that keeps the certificate storage's Redis server while shared state
 * uses it.
 *
 * Why a switch of its own, on the certificate storage's connection: one
 * Redis or Valkey deployment serves both (its settings, secrets, TLS,
 * Sentinel and cluster support, test and sealed sync are phase 1's), but
 * the two move different things: certificate storage moves where every
 * Caddy keeps certificates (turning it on or off makes Caddy look for them
 * elsewhere and order missing ones again), shared state moves where the web
 * nodes keep sessions and balances (turning it on or off signs forward-auth
 * users out once and hands balances over). Each can be turned on, tested and
 * rolled back without the other, and certificate storage alone (one web
 * node, several Caddy nodes) stays possible.
 *
 * The setting is this instance's own: not synced to slaves (a slave has no
 * users, groups or API consumers to keep state for, and serves neither
 * Ingressi forward auth nor monetized hosts), not in configuration export,
 * history or fleet revisions, like API monetization. High availability
 * standbys share the leader's database, setting included.
 */
import { clearSetting, getEffectiveSetting, setSetting } from "@/src/lib/settings";
import { getInstanceMode } from "@/src/lib/instance-sync";
import { withSettingsUpdateLock } from "@/src/lib/settings-update-lock";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiConflictError, ApiValidationError } from "@/src/lib/api-errors";
import { appDb } from "@/src/lib/db";
import { monetizationConsumers } from "@/src/lib/db/schema";
import { flushUsage, reloadMonetization } from "@/ee/monetization/engine";
import { parseStoredCertificateStorage } from "../settings";
import { CERTIFICATE_STORAGE_SETTING_KEY, REDIS_MODE_LABELS, type StoredRedisStorage } from "../types";
import {
  createSharedRedisClient,
  getSharedState,
  invalidateSharedState,
  readStoredSharedState,
  resolveSharedState,
  SharedStateUnavailableError,
  type SharedState,
} from "./connection";
import { forwardAuthKeyBase } from "./forward-auth-store";
import { isSharedStateLeader } from "./leader";
import { drainSharedMonetization, readDrainStatus } from "./monetization-drain";
import { monetizationKeyNames } from "./monetization-keys";
import { parseSharedStateInput, sharedStateNamespace } from "./settings";
import { SHARED_STATE_SETTING_KEY, type SharedStateKeyCounts, type SharedStateStatus, type SharedStateView, type StoredSharedState } from "./types";

export const SLAVE_SHARED_STATE_ERROR =
  "This instance is a sync slave: slaves keep request-path state local. Turn shared state on on the master or its high availability nodes.";

/** The server could not be used, or the balances could not be written back; nothing was changed. Safe to show. */
export class SharedStateChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharedStateChangeError";
  }
}

const CONNECT_CHECK_TIMEOUT_MS = 6_000;
/** The status counts per-consumer keys for at most this many consumers. */
const STATUS_CONSUMER_LIMIT = 5_000;

async function certificateStorageRedis(): Promise<StoredRedisStorage | null> {
  try {
    return parseStoredCertificateStorage(await getEffectiveSetting<unknown>(CERTIFICATE_STORAGE_SETTING_KEY))?.redis ?? null;
  } catch {
    return null;
  }
}

export async function getSharedStateView(): Promise<SharedStateView> {
  const stored = await readStoredSharedState();
  const resolved = await resolveSharedState();
  const redis = await certificateStorageRedis();
  const row = await appDb.query.settings.findFirst({ where: (table, { eq }) => eq(table.key, SHARED_STATE_SETTING_KEY) });
  return {
    enabled: stored?.enabled ?? false,
    backend: resolved.status === "on" ? "redis" : "local",
    keyPrefix: stored?.keyPrefix ?? "ingressi",
    namespace: stored?.enabled ? sharedStateNamespace(stored) : null,
    connection: {
      source: "certificate_storage",
      configured: redis !== null,
      mode: redis ? REDIS_MODE_LABELS[redis.mode] : null,
      addresses: redis ? [...redis.addresses] : [],
      tls: redis?.tls.enabled ?? false,
    },
    updatedAt: row?.updatedAt ?? null,
    editable: (await getInstanceMode()) !== "slave",
    error: resolved.status === "error" ? resolved.message : null,
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SharedStateChangeError(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Connects, signs in and runs PING, with this web container's view of the secrets. */
async function checkServer(redis: StoredRedisStorage): Promise<void> {
  let client;
  try {
    client = createSharedRedisClient(redis);
  } catch (error) {
    throw new SharedStateChangeError(error instanceof SharedStateUnavailableError ? error.message : "The Redis or Valkey settings cannot be used");
  }
  try {
    await withTimeout(
      (async () => {
        // The client connects lazily, on this first command.
        const reply = await client.ping();
        if (reply !== "PONG") throw new Error("unexpected reply");
      })(),
      CONNECT_CHECK_TIMEOUT_MS,
      "Redis or Valkey did not answer in time"
    );
  } catch (error) {
    if (error instanceof SharedStateChangeError) throw error;
    throw new SharedStateChangeError(
      "This web container could not connect to Redis or Valkey with the certificate storage settings (Test connection on the certificate storage card says more)"
    );
  } finally {
    client.disconnect();
  }
}

/** Writes everything of the state being left to the ledger; throws SharedStateChangeError when it cannot. */
async function finalDrain(state: SharedState): Promise<void> {
  try {
    const ids = (await appDb.select({ id: monetizationConsumers.id }).from(monetizationConsumers)).map((row) => row.id);
    await drainSharedMonetization(state, { consumerIds: ids });
  } catch {
    throw new SharedStateChangeError(
      "The shared API balances could not be written to the ledger, so nothing was changed. Try again, or remove the setting to turn shared state off anyway (usage and top-ups not yet in the ledger are then lost)."
    );
  }
}

async function assertEditable(): Promise<void> {
  if ((await getInstanceMode()) === "slave") throw new ApiConflictError(SLAVE_SHARED_STATE_ERROR);
}

function describe(setting: StoredSharedState | null): Record<string, unknown> {
  return setting ? { enabled: setting.enabled, keyPrefix: setting.keyPrefix, generation: setting.generation } : { enabled: false };
}

/**
 * Turns shared state on or off, or changes its key prefix ({enabled?,
 * keyPrefix?}). Turning it on checks that this web container can reach the
 * server and writes this node's metering to SQLite first; turning it off (or
 * moving to another prefix) writes the shared balances to the ledger first
 * and refuses when it cannot.
 */
export async function saveSharedState(body: unknown, actorUserId: number): Promise<SharedStateView> {
  await assertEditable();
  await withSettingsUpdateLock(async () => {
    const previous = await readStoredSharedState();
    const next = parseSharedStateInput(body, previous);
    if (
      previous &&
      previous.enabled === next.enabled &&
      previous.keyPrefix === next.keyPrefix &&
      previous.generation === next.generation
    ) {
      return;
    }
    const leaving = previous?.enabled && (!next.enabled || previous.generation !== next.generation);
    if (next.enabled) {
      const redis = await certificateStorageRedis();
      if (!redis) {
        throw new ApiValidationError(
          "Shared state uses the Redis or Valkey settings of the certificate storage: save them first (Certificate settings, Certificate storage), enabled or not"
        );
      }
      await checkServer(redis);
    }
    if (leaving) {
      const state = await getSharedState().catch(() => null);
      if (!state) throw new SharedStateChangeError("The current shared state cannot be reached, so its balances cannot be written to the ledger; nothing was changed");
      await finalDrain(state);
    }
    if (next.enabled && !previous?.enabled) {
      // This node's metering so far goes to SQLite, which the shared balances start from.
      await flushUsage();
    }

    await setSetting(SHARED_STATE_SETTING_KEY, next);
    invalidateSharedState();
    // The gate's index holds balances for the local counters: read them again.
    await reloadMonetization();
    await logAuditEvent({
      userId: actorUserId,
      action: "ha_shared_state_updated",
      entityType: "ha_shared_state",
      summary: next.enabled
        ? previous?.enabled
          ? `Moved high availability shared state to the key prefix ${next.keyPrefix}`
          : `Turned on high availability shared state (key prefix ${next.keyPrefix})`
        : "Turned off high availability shared state",
      data: { before: describe(previous), after: describe(next) },
    });
  });
  return getSharedStateView();
}

/**
 * Turns shared state off and forgets the setting, whatever the server says:
 * the balances are written to the ledger when the server answers, and what
 * was not written is lost (in the consumers' favour).
 */
export async function removeSharedState(actorUserId: number): Promise<SharedStateView> {
  await withSettingsUpdateLock(async () => {
    const previous = await readStoredSharedState();
    if (!previous) return;
    let drained: "written" | "failed" | "not needed" = "not needed";
    if (previous.enabled) {
      const state = await getSharedState().catch(() => null);
      drained = "failed";
      if (state) {
        try {
          await finalDrain(state);
          drained = "written";
        } catch {
          // Recorded below.
        }
      }
    }
    await clearSetting(SHARED_STATE_SETTING_KEY);
    invalidateSharedState();
    await reloadMonetization();
    await logAuditEvent({
      userId: actorUserId,
      action: "ha_shared_state_removed",
      entityType: "ha_shared_state",
      summary:
        drained === "failed"
          ? "Removed the high availability shared state setting; the shared balances could not be written to the ledger"
          : "Removed the high availability shared state setting",
      data: { before: describe(previous), balances: drained },
    });
  });
  return getSharedStateView();
}

async function countKeys(state: SharedState): Promise<SharedStateKeyCounts> {
  const base = forwardAuthKeyBase(state.namespace);
  const keys = monetizationKeyNames(state.namespace);
  const ids = (await appDb
    .select({ id: monetizationConsumers.id })
    .from(monetizationConsumers)
    .limit(STATUS_CONSUMER_LIMIT))
    .map((row) => row.id);
  const [sessions, exists, pending] = await Promise.all([
    state.redis.zcount(`${base}all`, Date.now() + 1, "+inf"),
    Promise.all(ids.map((id) => state.redis.exists(keys.consumer(id)))),
    Promise.all(ids.map((id) => state.redis.llen(keys.credits(id)))),
  ]);
  return {
    forwardAuthSessions: Number(sessions),
    monetizationConsumers: exists.reduce((sum: number, value) => sum + Number(value), 0),
    pendingCredits: pending.reduce((sum: number, value) => sum + Number(value), 0),
  };
}

/** What the shared state holds now and when the leader last wrote it back. Read-only. */
export async function getSharedStateStatus(): Promise<SharedStateStatus> {
  const leader = await isSharedStateLeader();
  let state: SharedState | null;
  try {
    state = await getSharedState();
  } catch (error) {
    return {
      backend: "redis",
      reachable: false,
      error: error instanceof SharedStateUnavailableError ? error.message : "Shared state cannot be used",
      keys: null,
      drain: null,
      leader,
    };
  }
  if (!state) return { backend: "local", reachable: null, error: null, keys: null, drain: null, leader };
  try {
    const ping = await withTimeout(state.redis.ping(), CONNECT_CHECK_TIMEOUT_MS, "Redis or Valkey did not answer in time");
    if (ping !== "PONG") throw new Error("unexpected reply");
    const [keys, drain] = await Promise.all([countKeys(state), readDrainStatus(state)]);
    return { backend: "redis", reachable: true, error: null, keys, drain, leader };
  } catch (error) {
    return {
      backend: "redis",
      reachable: false,
      error: error instanceof SharedStateChangeError ? error.message : "Redis or Valkey did not answer",
      keys: null,
      drain: null,
      leader,
    };
  }
}

function destinationOf(redis: StoredRedisStorage | null): string {
  if (!redis) return "none";
  return JSON.stringify([redis.mode, [...redis.addresses].sort(), redis.masterName ?? null, redis.db]);
}

/**
 * 409 when a certificate storage change would move shared state to another
 * server (or remove its settings) while it is on: its sessions and balances
 * are on the current one. Password, TLS and prefix changes are allowed.
 */
export async function assertSharedStateServerKept(previous: StoredRedisStorage | null, next: StoredRedisStorage | null): Promise<void> {
  if (!(await readStoredSharedState())?.enabled) return;
  if (destinationOf(previous) === destinationOf(next)) return;
  throw new ApiConflictError(
    "High availability shared state (forward-auth sessions, API balances) uses this Redis or Valkey server: turn shared state off first, then change the server"
  );
}
