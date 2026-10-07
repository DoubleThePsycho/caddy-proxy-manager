// SPDX-License-Identifier: Elastic-2.0
/**
 * High availability, phase 1: shared certificate storage for Caddy nodes.
 * Shared types and constants. Safe to import from client components:
 * nothing here touches the database.
 */

/** The settings key (instance sync stores the master's as synced:certificate_storage). */
export const CERTIFICATE_STORAGE_SETTING_KEY = "certificate_storage";

/** "local": each Caddy keeps certificates in its own /data (the default). "redis": Redis or Valkey, shared. */
export const STORAGE_BACKENDS = ["local", "redis"] as const;
export type StorageBackend = (typeof STORAGE_BACKENDS)[number];

export const REDIS_MODES = ["standalone", "cluster", "sentinel"] as const;
export type RedisMode = (typeof REDIS_MODES)[number];

export const REDIS_MODE_LABELS: Record<RedisMode, string> = {
  standalone: "Single server",
  cluster: "Cluster",
  sentinel: "Sentinel (failover)",
};

/** The secrets of a Redis storage, each stored encrypted or read from an environment variable on the Caddy nodes. */
export const STORAGE_SECRET_FIELDS = ["password", "sentinelPassword", "encryptionKey"] as const;
export type StorageSecretField = (typeof STORAGE_SECRET_FIELDS)[number];

export const STORAGE_SECRET_LABELS: Record<StorageSecretField, string> = {
  password: "password",
  sentinelPassword: "Sentinel password",
  encryptionKey: "encryption key",
};

/**
 * Environment variables named instead of a stored secret must start with
 * this, so a storage setting can only make Caddy send variables that were
 * set for it, never any other variable of the Caddy process.
 */
export const STORAGE_ENV_PREFIX = "CADDY_STORAGE_";

/** The variables the migration config names for secrets stored here. */
export const MIGRATION_ENV_NAMES: Record<StorageSecretField, string> = {
  password: "CADDY_STORAGE_PASSWORD",
  sentinelPassword: "CADDY_STORAGE_SENTINEL_PASSWORD",
  encryptionKey: "CADDY_STORAGE_ENCRYPTION_KEY",
};

export const DEFAULT_KEY_PREFIX = "caddy";

/** Seconds Caddy waits for the storage server when dialling, reading and writing. */
export const CADDY_STORAGE_TIMEOUT_SECONDS = 5;

export const STORAGE_LIMITS = {
  addresses: 16,
  host: 253,
  username: 128,
  password: 512,
  masterName: 128,
  keyPrefix: 200,
  /** The module uses the first 32 bytes of the key and refuses a shorter one. */
  encryptionKeyMin: 32,
  encryptionKeyMax: 512,
  db: 255,
  caPem: 64 * 1024,
} as const;

/** A Redis or Valkey storage as stored: secrets are encryptSecret() output. */
export type StoredRedisStorage = {
  mode: RedisMode;
  /** host:port of the server, of cluster nodes to start from, or of the Sentinels. */
  addresses: string[];
  /** Sentinel mode only: the name the Sentinels know the master by. */
  masterName?: string;
  db: number;
  username?: string;
  password?: string;
  passwordEnv?: string;
  sentinelPassword?: string;
  sentinelPasswordEnv?: string;
  keyPrefix: string;
  encryptionKey?: string;
  encryptionKeyEnv?: string;
  tls: { enabled: boolean; insecureSkipVerify: boolean; caPem?: string };
};

export type StoredCertificateStorage = {
  backend: StorageBackend;
  /** Kept when switching back to local, so shared storage can be turned on again. */
  redis: StoredRedisStorage | null;
};

export type RedisStorageView = {
  mode: RedisMode;
  addresses: string[];
  masterName: string | null;
  db: number;
  username: string | null;
  keyPrefix: string;
  hasPassword: boolean;
  passwordEnv: string | null;
  hasSentinelPassword: boolean;
  sentinelPasswordEnv: string | null;
  hasEncryptionKey: boolean;
  encryptionKeyEnv: string | null;
  tls: { enabled: boolean; insecureSkipVerify: boolean; caPem: string | null };
};

export type StorageMigrationConfig = {
  /** A Caddy JSON config with only this storage, for `caddy storage import/export`. Secrets are {env.*} placeholders. */
  config: { storage: Record<string, unknown> };
  /** The variables that config names, to set when running the command. */
  environment: string[];
};

export type CertificateStorageView = {
  backend: StorageBackend;
  redis: RedisStorageView | null;
  /** "default": never set (local); "local": set on this instance; "master": synced from the master. */
  source: "default" | "local" | "master";
  updatedAt: string | null;
  /** False on a sync slave, which uses the master's setting. */
  editable: boolean;
  /** Set when the stored value is not valid; Caddy keeps its previous configuration until it is saved again. */
  error: string | null;
  migration: StorageMigrationConfig | null;
  envPrefix: string;
};

export const STORAGE_TEST_STEPS = ["connect", "sentinel", "auth", "select", "write", "read", "delete"] as const;
export type StorageTestStepName = (typeof STORAGE_TEST_STEPS)[number];

export type StorageTestStep = { step: StorageTestStepName; ok: boolean; detail: string };

export type StorageTestResult = {
  /** Every step that ran succeeded. */
  ok: boolean;
  /** False when a step could not run from here (a secret read from the Caddy nodes' environment). */
  complete: boolean;
  /** host:port that answered the storage commands. */
  server: string | null;
  steps: StorageTestStep[];
};

/** What the dashboard's server actions return. */
export type CertificateStorageActionResult = { ok: true; view: CertificateStorageView } | { ok: false; error: string };
export type CertificateStorageTestActionResult = { ok: true; result: StorageTestResult } | { ok: false; error: string };
