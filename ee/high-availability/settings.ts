// SPDX-License-Identifier: Elastic-2.0
/**
 * Certificate storage settings: validation of REST and dashboard input,
 * parsing of stored values (saved here, synced from a master, imported or
 * restored), and comparing two settings. No database access, so instance
 * sync and the configuration code can use it.
 *
 * Secrets (the password, the Sentinel password and the encryption key) are
 * stored with encryptSecret, or named as an environment variable that every
 * Caddy node sets (CADDY_STORAGE_*), in which case they are never stored or
 * sent anywhere by this dashboard.
 */
import { X509Certificate } from "node:crypto";
import { ApiValidationError } from "@/src/lib/api-errors";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "@/src/lib/secret";
import { isPlainObject, rejectUnknownKeys, requireObject } from "@/ee/alerting/validation";
import { AddressError, parseHostPort } from "./address";
import {
  DEFAULT_KEY_PREFIX,
  REDIS_MODES,
  STORAGE_BACKENDS,
  STORAGE_ENV_PREFIX,
  STORAGE_LIMITS,
  STORAGE_SECRET_FIELDS,
  STORAGE_SECRET_LABELS,
  type RedisMode,
  type RedisStorageView,
  type StorageBackend,
  type StorageSecretField,
  type StoredCertificateStorage,
  type StoredRedisStorage,
} from "./types";

/** A stored certificate storage value that is not valid; the message is safe to show. */
export class CertificateStorageSettingError extends ApiValidationError {
  constructor(message: string) {
    super(`Certificate storage: ${message}`);
    this.name = "CertificateStorageSettingError";
  }
}

const ENV_FIELD: Record<StorageSecretField, "passwordEnv" | "sentinelPasswordEnv" | "encryptionKeyEnv"> = {
  password: "passwordEnv",
  sentinelPassword: "sentinelPasswordEnv",
  encryptionKey: "encryptionKeyEnv",
};

const REDIS_INPUT_KEYS = [
  "mode",
  "addresses",
  "masterName",
  "db",
  "username",
  "keyPrefix",
  "tls",
  ...STORAGE_SECRET_FIELDS,
  ...STORAGE_SECRET_FIELDS.map((field) => ENV_FIELD[field]),
] as const;

const KEY_PREFIX = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const MASTER_NAME = /^[A-Za-z0-9_.-]+$/;
const ENV_NAME = new RegExp(`^${STORAGE_ENV_PREFIX}[A-Z0-9_]{1,64}$`);
// Caddy expands {placeholders} in these values, so the plain fields may not contain braces.
const PLAIN_TEXT = /^[^\s{}\p{Cc}]+$/u;

function fail(message: string, stored: boolean): never {
  throw stored ? new CertificateStorageSettingError(message) : new ApiValidationError(message);
}

/** A "host:port" (IPv6 in brackets), normalized to lower case. */
export function parseStorageAddress(value: unknown, field = "address", stored = false): string {
  try {
    return parseHostPort(value, field);
  } catch (error) {
    if (error instanceof AddressError) fail(error.message, stored);
    throw error;
  }
}

function readAddresses(value: unknown, mode: RedisMode, stored: boolean): string[] {
  if (!Array.isArray(value) || value.length === 0) fail("addresses must list at least one host:port", stored);
  if (value.length > STORAGE_LIMITS.addresses) fail(`addresses can list at most ${STORAGE_LIMITS.addresses} servers`, stored);
  const addresses = [...new Set(value.map((item, index) => parseStorageAddress(item, `addresses[${index}]`, stored)))];
  if (mode === "standalone" && addresses.length !== 1) {
    fail("a single server has exactly one address; choose the cluster or Sentinel mode for several", stored);
  }
  return addresses;
}

function readMode(value: unknown, stored: boolean): RedisMode {
  if (value === undefined && !stored) return "standalone";
  if (typeof value !== "string" || !(REDIS_MODES as readonly string[]).includes(value)) {
    fail(`mode must be one of: ${REDIS_MODES.join(", ")}`, stored);
  }
  return value as RedisMode;
}

function readOptionalPlain(value: unknown, field: string, max: number, pattern: RegExp, stored: boolean): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") fail(`${field} must be a string`, stored);
  const text = value.trim();
  if (text.length === 0) return undefined;
  if (text.length > max) fail(`${field} must be at most ${max} characters`, stored);
  if (!pattern.test(text)) fail(`${field} contains characters that are not allowed`, stored);
  return text;
}

function readKeyPrefix(value: unknown, stored: boolean): string {
  if (value === undefined || value === null || value === "") {
    if (stored) fail("keyPrefix is missing", stored);
    return DEFAULT_KEY_PREFIX;
  }
  if (typeof value !== "string") fail("keyPrefix must be a string", stored);
  const prefix = value.trim();
  if (prefix.length > STORAGE_LIMITS.keyPrefix) fail(`keyPrefix must be at most ${STORAGE_LIMITS.keyPrefix} characters`, stored);
  if (!KEY_PREFIX.test(prefix) || prefix.split("/").some((segment) => segment === "." || segment === "..")) {
    fail('keyPrefix may contain letters, digits, ".", "_", "-" and "/" between segments (no "." or ".." segments)', stored);
  }
  return prefix;
}

function readDb(value: unknown, mode: RedisMode, stored: boolean): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > STORAGE_LIMITS.db) {
    fail(`db must be a whole number from 0 to ${STORAGE_LIMITS.db}`, stored);
  }
  if (mode === "cluster" && value !== 0) fail("a cluster only has database 0", stored);
  return value;
}

/** One or more PEM certificates; anything else (a private key, text around them) is refused. */
export function parseCaPem(value: unknown, stored = false): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") fail("tls.caPem must be a string", stored);
  const text = value.trim();
  if (text.length === 0) return undefined;
  if (text.length > STORAGE_LIMITS.caPem) fail(`tls.caPem must be at most ${STORAGE_LIMITS.caPem / 1024} KB`, stored);
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length === 0 || text.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g, "").trim() !== "") {
    fail("tls.caPem must contain only PEM certificates (-----BEGIN CERTIFICATE-----)", stored);
  }
  for (const block of blocks) {
    try {
      new X509Certificate(block);
    } catch {
      fail("tls.caPem contains a certificate that cannot be read", stored);
    }
  }
  return blocks.join("\n") + "\n";
}

function readTls(value: unknown, stored: boolean): StoredRedisStorage["tls"] {
  if (value === undefined || value === null) return { enabled: false, insecureSkipVerify: false };
  if (!isPlainObject(value)) fail("tls must be an object", stored);
  if (!stored) rejectUnknownKeys(value, ["enabled", "insecureSkipVerify", "caPem"], "tls");
  const enabled = value.enabled ?? false;
  const insecure = value.insecureSkipVerify ?? false;
  if (typeof enabled !== "boolean") fail("tls.enabled must be true or false", stored);
  if (typeof insecure !== "boolean") fail("tls.insecureSkipVerify must be true or false", stored);
  const caPem = parseCaPem(value.caPem, stored);
  if (!enabled) {
    if (insecure || caPem) fail("tls.insecureSkipVerify and tls.caPem need tls.enabled", stored);
    return { enabled: false, insecureSkipVerify: false };
  }
  if (insecure && caPem) fail("send either tls.caPem or tls.insecureSkipVerify, not both", stored);
  return { enabled: true, insecureSkipVerify: insecure, ...(caPem ? { caPem } : {}) };
}

function readEnvName(value: unknown, field: string, stored: boolean): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !ENV_NAME.test(value.trim())) {
    fail(`${field} must be an environment variable name starting with ${STORAGE_ENV_PREFIX} (A-Z, 0-9, _)`, stored);
  }
  return value.trim();
}

/** A secret typed by an administrator: kept as typed (no trimming), bounded, without control characters. */
function checkSecretValue(field: StorageSecretField, value: string, stored: boolean): void {
  if (/\p{Cc}/u.test(value)) fail(`${field} must not contain control characters`, stored);
  if (field === "encryptionKey") {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes < STORAGE_LIMITS.encryptionKeyMin) {
      fail(`encryptionKey must be at least ${STORAGE_LIMITS.encryptionKeyMin} bytes (only the first 32 are used)`, stored);
    }
    if (bytes > STORAGE_LIMITS.encryptionKeyMax) fail(`encryptionKey must be at most ${STORAGE_LIMITS.encryptionKeyMax} bytes`, stored);
  } else if (value.length > STORAGE_LIMITS.password) {
    fail(`${field} must be at most ${STORAGE_LIMITS.password} characters`, stored);
  }
}

type PlainRedisFields = Omit<StoredRedisStorage, StorageSecretField | "passwordEnv" | "sentinelPasswordEnv" | "encryptionKeyEnv">;

function readPlainRedisFields(record: Record<string, unknown>, stored: boolean): PlainRedisFields {
  const mode = readMode(record.mode, stored);
  const addresses = readAddresses(record.addresses, mode, stored);
  const masterName = readOptionalPlain(record.masterName, "masterName", STORAGE_LIMITS.masterName, MASTER_NAME, stored);
  if (mode === "sentinel" && !masterName) fail("masterName is required in Sentinel mode", stored);
  if (mode !== "sentinel" && masterName) fail("masterName is only used in Sentinel mode", stored);
  const username = readOptionalPlain(record.username, "username", STORAGE_LIMITS.username, PLAIN_TEXT, stored);
  return {
    mode,
    addresses,
    ...(masterName ? { masterName } : {}),
    db: readDb(record.db, mode, stored),
    ...(username ? { username } : {}),
    keyPrefix: readKeyPrefix(record.keyPrefix, stored),
    tls: readTls(record.tls, stored),
  };
}

/** Where a password goes: changing any of this means a stored password must be entered again. */
function destinationOf(redis: Pick<StoredRedisStorage, "mode" | "addresses" | "masterName" | "tls">): string {
  return JSON.stringify([
    redis.mode,
    [...redis.addresses].sort(),
    redis.masterName ?? null,
    redis.tls.enabled,
    redis.tls.insecureSkipVerify,
    redis.tls.caPem ?? null,
  ]);
}

/** The order the fields are stored in, so equal settings serialize equally. */
function ordered(redis: StoredRedisStorage): StoredRedisStorage {
  const result: StoredRedisStorage = {
    mode: redis.mode,
    addresses: redis.addresses,
    ...(redis.masterName ? { masterName: redis.masterName } : {}),
    db: redis.db,
    ...(redis.username ? { username: redis.username } : {}),
    keyPrefix: redis.keyPrefix,
    tls: redis.tls,
  };
  for (const field of STORAGE_SECRET_FIELDS) {
    if (redis[field]) result[field] = redis[field];
    if (redis[ENV_FIELD[field]]) result[ENV_FIELD[field]] = redis[ENV_FIELD[field]];
  }
  return result;
}

/**
 * The Redis storage an API body describes. Plain fields are taken as sent
 * (missing ones get their defaults). For each secret: a string replaces it,
 * null removes it, "" or a missing field keeps the stored one; the *Env field
 * names an environment variable instead (null or "" stops using one). A
 * stored password is only kept while the addresses, mode and TLS settings
 * stay the same: it may only go to the servers it was entered for.
 */
export function parseRedisStorageInput(value: unknown, previous: StoredRedisStorage | null): StoredRedisStorage {
  const record = requireObject(value, "redis");
  rejectUnknownKeys(record, REDIS_INPUT_KEYS, "redis");
  const plain = readPlainRedisFields(record, false);
  const sameDestination = previous !== null && destinationOf(previous) === destinationOf(plain);
  const next: StoredRedisStorage = { ...plain };

  for (const field of STORAGE_SECRET_FIELDS) {
    const envField = ENV_FIELD[field];
    const label = STORAGE_SECRET_LABELS[field];
    const rawValue = record[field];
    const rawEnv = record[envField];
    if (rawValue !== undefined && rawValue !== null && typeof rawValue !== "string") {
      throw new ApiValidationError(`${field} must be a string or null`);
    }
    const env = readEnvName(rawEnv, envField, false);
    const setValue = typeof rawValue === "string" && rawValue !== "" ? rawValue : null;
    if (setValue !== null && env) throw new ApiValidationError(`Send either ${field} or ${envField}, not both`);
    if (field === "sentinelPassword" && plain.mode !== "sentinel" && (setValue !== null || env)) {
      throw new ApiValidationError("sentinelPassword is only used in Sentinel mode");
    }

    if (env) {
      next[envField] = env;
    } else if (setValue !== null) {
      checkSecretValue(field, setValue, false);
      next[field] = encryptSecret(setValue);
    } else if (rawValue === null) {
      // Removed, together with any variable it was read from.
    } else if (field === "sentinelPassword" && plain.mode !== "sentinel") {
      // Only used in Sentinel mode: a kept one is dropped with the mode.
    } else if (previous) {
      if (previous[envField] && rawEnv === undefined) next[envField] = previous[envField];
      if (previous[field]) {
        if (field !== "encryptionKey" && !sameDestination) {
          throw new ApiValidationError(
            `Enter the ${label} again when changing the addresses, mode or TLS settings, or send null to remove it`
          );
        }
        next[field] = previous[field];
      }
    }
  }
  return ordered(next);
}

/**
 * The certificate storage an API body ({backend?, redis?}) describes, given
 * the stored one. A missing `redis` keeps the stored Redis settings (so
 * {"backend": "local"} switches back to local storage and keeps them for
 * later); `redis: null` removes them.
 */
export function parseCertificateStorageInput(body: unknown, previous: StoredCertificateStorage | null): StoredCertificateStorage {
  const record = requireObject(body, "Request body");
  rejectUnknownKeys(record, ["backend", "redis"], "the certificate storage settings");
  const redis =
    record.redis === undefined
      ? previous?.redis ?? null
      : record.redis === null
        ? null
        : parseRedisStorageInput(record.redis, previous?.redis ?? null);
  const backendInput = record.backend ?? previous?.backend ?? (redis ? "redis" : "local");
  if (typeof backendInput !== "string" || !(STORAGE_BACKENDS as readonly string[]).includes(backendInput)) {
    throw new ApiValidationError(`backend must be one of: ${STORAGE_BACKENDS.join(", ")}`);
  }
  const backend = backendInput as StorageBackend;
  if (backend === "redis" && !redis) throw new ApiValidationError("Configure redis to use the redis backend");
  return { backend, redis };
}

/**
 * A stored value (local, synced from a master, imported or restored) as
 * certificate storage: null when unset, CertificateStorageSettingError when
 * it is not valid. Secrets stay as stored.
 */
export function parseStoredCertificateStorage(value: unknown): StoredCertificateStorage | null {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) fail("the setting must be an object", true);
  const backend = value.backend;
  if (typeof backend !== "string" || !(STORAGE_BACKENDS as readonly string[]).includes(backend)) {
    fail(`backend must be one of: ${STORAGE_BACKENDS.join(", ")}`, true);
  }
  let redis: StoredRedisStorage | null = null;
  if (value.redis !== null && value.redis !== undefined) {
    if (!isPlainObject(value.redis)) fail("redis must be an object", true);
    const record = value.redis;
    const parsed: StoredRedisStorage = readPlainRedisFields(record, true);
    for (const field of STORAGE_SECRET_FIELDS) {
      const envField = ENV_FIELD[field];
      const env = readEnvName(record[envField], envField, true);
      const secret = record[field];
      if (secret !== undefined && secret !== null && (typeof secret !== "string" || secret === "")) {
        fail(`${field} must be a non-empty string`, true);
      }
      if (typeof secret === "string" && env) fail(`${field} and ${envField} are both set`, true);
      if (field === "sentinelPassword" && parsed.mode !== "sentinel" && (secret || env)) {
        fail("sentinelPassword is only used in Sentinel mode", true);
      }
      if (typeof secret === "string") {
        // Encrypted values are checked when they are decrypted; plaintext (an
        // older master's payload, a hand-edited import) is checked here.
        if (!isEncryptedSecret(secret)) checkSecretValue(field, secret, true);
        parsed[field] = secret;
      }
      if (env) parsed[envField] = env;
    }
    redis = ordered(parsed);
  }
  if (backend === "redis" && !redis) fail("the redis backend has no redis settings", true);
  return { backend: backend as StorageBackend, redis };
}

/**
 * The value with plaintext secrets encrypted (a slave storing a payload from
 * an older master, an import, the startup rotation). Anything that is not a
 * certificate storage object is returned unchanged.
 */
export function encryptCertificateStorageSecrets(value: unknown): unknown {
  if (!isPlainObject(value) || !isPlainObject(value.redis)) return value;
  const redis: Record<string, unknown> = { ...value.redis };
  let changed = false;
  for (const field of STORAGE_SECRET_FIELDS) {
    const secret = redis[field];
    if (typeof secret === "string" && secret && !isEncryptedSecret(secret)) {
      redis[field] = encryptSecret(secret);
      changed = true;
    }
  }
  return changed ? { ...value, redis } : value;
}

/** A secret in comparable form: decrypted (in memory only), so a re-encrypted secret is still the same secret. */
function comparableSecret(secret: string | undefined): unknown {
  if (!secret) return null;
  try {
    return ["plain", decryptSecret(secret)];
  } catch {
    return ["stored", secret];
  }
}

function comparable(redis: StoredRedisStorage | null): string {
  if (!redis) return "null";
  const copy: Record<string, unknown> = { ...ordered(redis) };
  for (const field of STORAGE_SECRET_FIELDS) {
    if (redis[field]) copy[field] = comparableSecret(redis[field]);
  }
  return JSON.stringify(copy);
}

/** Whether a secret was set, removed, replaced or moved to (or from) an environment variable. */
export function storageSecretChanged(
  before: StoredRedisStorage | null,
  after: StoredRedisStorage | null,
  field: StorageSecretField
): boolean {
  const envField = ENV_FIELD[field];
  if ((before?.[envField] ?? null) !== (after?.[envField] ?? null)) return true;
  return JSON.stringify(comparableSecret(before?.[field])) !== JSON.stringify(comparableSecret(after?.[field]));
}

export function sameRedisStorage(a: StoredRedisStorage | null, b: StoredRedisStorage | null): boolean {
  return comparable(a) === comparable(b);
}

function backendOf(storage: StoredCertificateStorage | null): StorageBackend {
  return storage?.backend ?? "local";
}

export function sameCertificateStorage(a: StoredCertificateStorage | null, b: StoredCertificateStorage | null): boolean {
  return backendOf(a) === backendOf(b) && sameRedisStorage(a?.redis ?? null, b?.redis ?? null);
}

export function toRedisStorageView(redis: StoredRedisStorage): RedisStorageView {
  return {
    mode: redis.mode,
    addresses: [...redis.addresses],
    masterName: redis.masterName ?? null,
    db: redis.db,
    username: redis.username ?? null,
    keyPrefix: redis.keyPrefix,
    hasPassword: Boolean(redis.password),
    passwordEnv: redis.passwordEnv ?? null,
    hasSentinelPassword: Boolean(redis.sentinelPassword),
    sentinelPasswordEnv: redis.sentinelPasswordEnv ?? null,
    hasEncryptionKey: Boolean(redis.encryptionKey),
    encryptionKeyEnv: redis.encryptionKeyEnv ?? null,
    tls: { enabled: redis.tls.enabled, insecureSkipVerify: redis.tls.insecureSkipVerify, caPem: redis.tls.caPem ?? null },
  };
}

export { ENV_FIELD as STORAGE_SECRET_ENV_FIELDS };
