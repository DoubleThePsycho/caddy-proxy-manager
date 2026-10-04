// SPDX-License-Identifier: Elastic-2.0
/**
 * The top-level `storage` of the generated Caddy configuration
 * (buildCaddyDocument in src/lib/caddy.ts): the caddy.storage.redis module
 * (github.com/pberkel/caddy-storage-redis) when shared storage is on, nothing
 * for local storage. Runs on every node, master or slave, from the setting in
 * effect there, and never checks the license: storage that is configured
 * keeps working when a license lapses.
 *
 * The module runs every string field through Caddy's placeholder replacer,
 * so a secret named as an environment variable becomes {env.NAME} (the Caddy
 * process reads it; it never appears in the configuration), and braces in a
 * stored secret are escaped so they reach the server as typed.
 */
import { getEffectiveSetting } from "@/src/lib/settings";
import { decryptSecret } from "@/src/lib/secret";
import { parseStoredCertificateStorage, STORAGE_SECRET_ENV_FIELDS } from "./settings";
import {
  CADDY_STORAGE_TIMEOUT_SECONDS,
  CERTIFICATE_STORAGE_SETTING_KEY,
  MIGRATION_ENV_NAMES,
  STORAGE_SECRET_FIELDS,
  STORAGE_SECRET_LABELS,
  type StorageMigrationConfig,
  type StorageSecretField,
  type StoredRedisStorage,
} from "./types";

const CLIENT_TYPES = { standalone: "simple", cluster: "cluster", sentinel: "failover" } as const;

const SECRET_KEYS: Record<StorageSecretField, string> = {
  password: "password",
  sentinelPassword: "sentinel_password",
  encryptionKey: "encryption_key",
};

/** A value as Caddy's replacer gives it back: braces escaped, everything else as is. */
export function escapeCaddyPlaceholders(value: string): string {
  return value.replace(/[{}]/g, (brace) => `\\${brace}`);
}

export function envPlaceholder(name: string): string {
  return `{env.${name}}`;
}

/**
 * The caddy.storage.redis module config. `secret` gives the value to write
 * for each secret that is set (stored or named as a variable).
 */
export function buildRedisStorageModule(
  redis: StoredRedisStorage,
  secret: (field: StorageSecretField) => string
): Record<string, unknown> {
  const storage: Record<string, unknown> = {
    module: "redis",
    client_type: CLIENT_TYPES[redis.mode],
    address: [...redis.addresses],
    db: redis.db,
    key_prefix: redis.keyPrefix,
    timeout: String(CADDY_STORAGE_TIMEOUT_SECONDS),
  };
  if (redis.mode === "sentinel" && redis.masterName) storage.master_name = redis.masterName;
  if (redis.username) storage.username = redis.username;
  for (const field of STORAGE_SECRET_FIELDS) {
    if (redis[field] || redis[STORAGE_SECRET_ENV_FIELDS[field]]) storage[SECRET_KEYS[field]] = secret(field);
  }
  if (redis.tls.enabled) {
    storage.tls_enabled = true;
    storage.tls_insecure = redis.tls.insecureSkipVerify;
    if (redis.tls.caPem) storage.tls_server_certs_pem = redis.tls.caPem;
  }
  return storage;
}

/** The value Caddy gets for a secret: {env.NAME}, or the stored secret decrypted and escaped. */
function runtimeSecret(redis: StoredRedisStorage, field: StorageSecretField): string {
  const env = redis[STORAGE_SECRET_ENV_FIELDS[field]];
  if (env) return envPlaceholder(env);
  try {
    return escapeCaddyPlaceholders(decryptSecret(redis[field]!, `certificate storage ${STORAGE_SECRET_LABELS[field]}`));
  } catch {
    // Failing the build keeps Caddy on its current configuration; dropping
    // the secret, or the storage, would make it order every certificate again.
    throw new Error(
      `The certificate storage ${STORAGE_SECRET_LABELS[field]} cannot be decrypted with SESSION_SECRET or ` +
      "SESSION_SECRET_PREVIOUS; enter it again"
    );
  }
}

/**
 * The `storage` value for this node's Caddy, or null for local storage.
 * Throws when the stored setting is not valid, so a broken setting never
 * silently switches a node to local storage.
 */
export async function resolveCaddyStorage(): Promise<Record<string, unknown> | null> {
  const stored = parseStoredCertificateStorage(await getEffectiveSetting<unknown>(CERTIFICATE_STORAGE_SETTING_KEY));
  if (!stored || stored.backend !== "redis" || !stored.redis) return null;
  const redis = stored.redis;
  return buildRedisStorageModule(redis, (field) => runtimeSecret(redis, field));
}

/**
 * A Caddy config holding only this storage, for `caddy storage export` and
 * `caddy storage import` when moving certificates in or out. No secret is in
 * it: each is an {env.*} placeholder (the variable already used, or
 * MIGRATION_ENV_NAMES for one stored here) to set when running the command.
 */
export function buildMigrationConfig(redis: StoredRedisStorage): StorageMigrationConfig {
  const environment: string[] = [];
  const storage = buildRedisStorageModule(redis, (field) => {
    const name = redis[STORAGE_SECRET_ENV_FIELDS[field]] ?? MIGRATION_ENV_NAMES[field];
    environment.push(name);
    return envPlaceholder(name);
  });
  return { config: { storage }, environment };
}
