// SPDX-License-Identifier: Elastic-2.0
/**
 * High availability (feature "high_availability", Enterprise), phase 1:
 * where the Caddy nodes keep certificates. Local storage (each Caddy in its
 * own /data) is the default; shared storage puts them in Redis or Valkey, so
 * every node uses the same certificates, orders each one once and can answer
 * any node's HTTP-01 and TLS-ALPN-01 challenges.
 *
 * Setting up, enabling and changing shared storage need a license that
 * includes the feature. Switching back to local storage, removing the
 * setting, reading and testing never do, and the generated Caddy
 * configuration (caddy-storage.ts) never checks it.
 *
 * The setting is a settings group of its own ("certificate_storage"), synced
 * to slave instances with its secrets sealed to each slave's key, captured in
 * configuration history, fleet revisions and configuration export. A slave
 * uses the master's setting and cannot change it.
 */
import { eq } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { settings as settingsTable } from "@/src/lib/db/schema";
import { clearSetting, getEffectiveSetting, setSetting } from "@/src/lib/settings";
import { applyCaddyConfig } from "@/src/lib/caddy";
import { CaddyApplyError } from "@/src/lib/caddy-apply-error";
import { getInstanceMode } from "@/src/lib/instance-sync";
import { withSettingsUpdateLock } from "@/src/lib/settings-update-lock";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiConflictError, ApiValidationError } from "@/src/lib/api-errors";
import { isFeatureConfigurable, requireFeature } from "@/ee/licensing/store";
import { rejectUnknownKeys, requireObject } from "@/ee/alerting/validation";
import { buildMigrationConfig } from "./caddy-storage";
import { invalidateSharedState } from "./shared-state/connection";
import { assertSharedStateServerKept } from "./shared-state/service";
import { testRedisStorage } from "./redis-check";
import {
  parseCertificateStorageInput,
  parseRedisStorageInput,
  parseStoredCertificateStorage,
  sameCertificateStorage,
  storageChangeNeedsLicense,
  storageSecretChanged,
  STORAGE_SECRET_ENV_FIELDS,
  toRedisStorageView,
} from "./settings";
import {
  CERTIFICATE_STORAGE_SETTING_KEY,
  HIGH_AVAILABILITY_FEATURE,
  REDIS_MODE_LABELS,
  STORAGE_ENV_PREFIX,
  STORAGE_SECRET_FIELDS,
  type CertificateStorageView,
  type StorageTestResult,
  type StoredCertificateStorage,
  type StoredRedisStorage,
} from "./types";
import { first } from "@/src/lib/db/ops";

export const SLAVE_STORAGE_ERROR =
  "This instance is a sync slave: it uses the master's certificate storage setting. Change it on the master.";

/** Caddy did not accept the new storage; the previous setting was put back. The message is safe to show. */
export class CertificateStorageApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CertificateStorageApplyError";
  }
}

type SettingRow = { value: unknown; updatedAt: string };

async function readRow(key: string): Promise<SettingRow | null> {
  const row = await first(appDb.select().from(settingsTable).where(eq(settingsTable.key, key)).limit(1));
  if (!row) return null;
  try {
    const value: unknown = JSON.parse(row.value);
    return value === null ? null : { value, updatedAt: row.updatedAt };
  } catch {
    return null;
  }
}

export async function getCertificateStorageView(): Promise<CertificateStorageView> {
  const mode = await getInstanceMode();
  const local = await readRow(CERTIFICATE_STORAGE_SETTING_KEY);
  const synced = mode === "slave" && !local ? await readRow(`synced:${CERTIFICATE_STORAGE_SETTING_KEY}`) : null;
  const row = local ?? synced;
  let stored: StoredCertificateStorage | null = null;
  let error: string | null = null;
  try {
    stored = parseStoredCertificateStorage(row?.value ?? null);
  } catch (parseError) {
    error = parseError instanceof Error ? parseError.message : "The stored setting is not valid";
  }
  return {
    backend: stored?.backend ?? "local",
    redis: stored?.redis ? toRedisStorageView(stored.redis) : null,
    source: local ? "local" : synced ? "master" : "default",
    updatedAt: row?.updatedAt ?? null,
    configurable: await isFeatureConfigurable(HIGH_AVAILABILITY_FEATURE),
    editable: mode !== "slave",
    error,
    migration: stored?.redis ? buildMigrationConfig(stored.redis) : null,
    envPrefix: STORAGE_ENV_PREFIX,
  };
}

async function assertEditable(): Promise<void> {
  if ((await getInstanceMode()) === "slave") throw new ApiConflictError(SLAVE_STORAGE_ERROR);
}

/**
 * Applies the configuration with the new setting. When Caddy does not take
 * it (most often: it cannot reach or sign in to the storage server, which
 * the redis module checks while loading), `previousValue` is stored again,
 * the previous configuration re-applied, and CertificateStorageApplyError
 * thrown.
 */
async function applyOrRestore(previousValue: unknown): Promise<void> {
  try {
    await applyCaddyConfig();
  } catch (error) {
    // Caddy took the configuration; only pushing it to slaves failed, and the next sync retries.
    if (error instanceof CaddyApplyError && error.code === "INSTANCE_SYNC_FAILED") return;
    if (previousValue === null || previousValue === undefined) {
      await clearSetting(CERTIFICATE_STORAGE_SETTING_KEY);
    } else {
      await setSetting(CERTIFICATE_STORAGE_SETTING_KEY, previousValue);
    }
    try {
      await applyCaddyConfig();
    } catch {
      // The database holds the previous setting again; the Caddy monitor and the next change re-apply it.
    }
    const reason = error instanceof CaddyApplyError ? error.message : "building the Caddy configuration failed";
    throw new CertificateStorageApplyError(`Caddy did not accept the certificate storage (${reason}). Nothing was changed.`);
  }
}

function describeRedis(redis: StoredRedisStorage): string {
  return `${REDIS_MODE_LABELS[redis.mode].toLowerCase()}, ${redis.addresses.join(", ")}, prefix ${redis.keyPrefix}`;
}

/** Audit data without secrets: where each secret comes from, and which ones changed. */
function auditData(previous: StoredCertificateStorage | null, next: StoredCertificateStorage | null) {
  const redis = next?.redis ?? null;
  return {
    previousBackend: previous?.backend ?? "local",
    backend: next?.backend ?? "local",
    redis: redis
      ? {
          mode: redis.mode,
          addresses: redis.addresses,
          masterName: redis.masterName ?? null,
          db: redis.db,
          username: redis.username ?? null,
          keyPrefix: redis.keyPrefix,
          tls: { enabled: redis.tls.enabled, insecureSkipVerify: redis.tls.insecureSkipVerify, caPem: Boolean(redis.tls.caPem) },
          secrets: Object.fromEntries(
            STORAGE_SECRET_FIELDS.map((field) => {
              const env = redis[STORAGE_SECRET_ENV_FIELDS[field]];
              return [field, env ? `env:${env}` : redis[field] ? "stored" : null];
            })
          ),
        }
      : null,
    secretsChanged: STORAGE_SECRET_FIELDS.filter((field) => storageSecretChanged(previous?.redis ?? null, redis, field)),
  };
}

function summaryOf(previous: StoredCertificateStorage | null, next: StoredCertificateStorage): string {
  const before = previous?.backend ?? "local";
  if (next.backend === "redis" && before !== "redis") return `Switched certificate storage to Redis/Valkey (${describeRedis(next.redis!)})`;
  if (next.backend === "local" && before === "redis") {
    return next.redis ? "Switched certificate storage back to local (Redis/Valkey settings kept)" : "Switched certificate storage back to local";
  }
  if (next.redis) return `Changed the Redis/Valkey certificate storage settings (${describeRedis(next.redis)})`;
  return "Removed the Redis/Valkey certificate storage settings";
}

/**
 * Validates and stores the certificate storage ({backend?, redis?}, see
 * parseCertificateStorageInput) and applies it. Needs the license unless the
 * result is local storage with the Redis settings unchanged or removed.
 */
export async function saveCertificateStorage(body: unknown, actorUserId: number): Promise<CertificateStorageView> {
  await assertEditable();
  await withSettingsUpdateLock(async () => {
    const previousRow = await readRow(CERTIFICATE_STORAGE_SETTING_KEY);
    let previous: StoredCertificateStorage | null = null;
    let previousValid = true;
    try {
      previous = parseStoredCertificateStorage(previousRow?.value ?? null);
    } catch {
      // A value that is not valid is replaced, never built upon.
      previousValid = false;
    }
    const next = parseCertificateStorageInput(body, previous);
    if (previousValid && sameCertificateStorage(previous, next)) return;
    // Shared state (phase 3) keeps sessions and balances on this server.
    await assertSharedStateServerKept(previous?.redis ?? null, next.redis);
    if (storageChangeNeedsLicense(previous, next)) await requireFeature(HIGH_AVAILABILITY_FEATURE);

    await setSetting(CERTIFICATE_STORAGE_SETTING_KEY, next);
    invalidateSharedState();
    await applyOrRestore(previousRow?.value ?? null);
    invalidateSharedState();
    await logAuditEvent({
      userId: actorUserId,
      action: "certificate_storage_updated",
      entityType: "certificate_storage",
      summary: summaryOf(previous, next),
      data: auditData(previous, next),
    });
  });
  return getCertificateStorageView();
}

/**
 * Removes this instance's setting: local storage, and the Redis settings are
 * forgotten. Never needs a license. On a slave this removes a setting of its
 * own, if it has one, so the master's applies again.
 */
export async function removeCertificateStorage(actorUserId: number): Promise<CertificateStorageView> {
  await withSettingsUpdateLock(async () => {
    const previousRow = await readRow(CERTIFICATE_STORAGE_SETTING_KEY);
    if (!previousRow) return;
    let previous: StoredCertificateStorage | null;
    try {
      previous = parseStoredCertificateStorage(previousRow.value);
    } catch {
      previous = null;
    }
    await assertSharedStateServerKept(previous?.redis ?? null, null);
    await clearSetting(CERTIFICATE_STORAGE_SETTING_KEY);
    invalidateSharedState();
    await applyOrRestore(previousRow.value);
    invalidateSharedState();
    await logAuditEvent({
      userId: actorUserId,
      action: "certificate_storage_removed",
      entityType: "certificate_storage",
      summary:
        previous?.backend === "redis"
          ? "Removed the certificate storage setting: back to local storage"
          : "Removed the certificate storage setting",
      data: auditData(previous, null),
    });
  });
  return getCertificateStorageView();
}

/**
 * Tests the storage from this instance: the setting in effect, or the Redis
 * settings in the body ({redis: {...}}, read like a save, with the stored
 * secrets for the ones left out). Changes nothing and needs no license.
 */
export async function testCertificateStorage(body: unknown, actorUserId: number): Promise<StorageTestResult> {
  const record = body === undefined || body === null ? {} : requireObject(body, "Request body");
  rejectUnknownKeys(record, ["redis"], "a certificate storage test");
  let effective: StoredCertificateStorage | null;
  try {
    effective = parseStoredCertificateStorage(await getEffectiveSetting<unknown>(CERTIFICATE_STORAGE_SETTING_KEY));
  } catch {
    effective = null;
  }
  let redis: StoredRedisStorage;
  if (record.redis !== undefined && record.redis !== null) {
    redis = parseRedisStorageInput(record.redis, effective?.redis ?? null);
  } else if (effective?.redis) {
    redis = effective.redis;
  } else {
    throw new ApiValidationError("Nothing to test: configure Redis or Valkey first, or send the settings to test as redis");
  }

  const result = await testRedisStorage(redis);
  await logAuditEvent({
    userId: actorUserId,
    action: "certificate_storage_tested",
    entityType: "certificate_storage",
    summary: `Tested the Redis/Valkey certificate storage (${describeRedis(redis)}): ${
      result.ok ? (result.complete ? "succeeded" : "reachable, not fully tested") : "failed"
    }`,
    data: { ok: result.ok, complete: result.complete, server: result.server, steps: result.steps },
  });
  return result;
}
