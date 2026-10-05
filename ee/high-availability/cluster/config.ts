// SPDX-License-Identifier: Elastic-2.0
/**
 * The dashboard cluster's configuration: environment variables only, read by
 * the supervisor (supervisor.ts) and shown by the dashboard (view.ts). With
 * HA_ENABLED unset nothing here applies and the container starts as before.
 *
 * Secrets (the Redis passwords, the object storage keys) are kept in memory
 * only; nothing here returns or logs them.
 */
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { isPostgresUrl } from "@/src/lib/db/dialect";
import { AddressError, parseHostPort } from "../address";
import type { ClusterConfigView } from "./types";

export const HA_ENV = {
  enabled: "HA_ENABLED",
  nodeId: "HA_NODE_ID",
  redisMode: "HA_REDIS_MODE",
  redisAddresses: "HA_REDIS_ADDRESSES",
  redisMasterName: "HA_REDIS_MASTER_NAME",
  redisDb: "HA_REDIS_DB",
  redisUsername: "HA_REDIS_USERNAME",
  redisPassword: "HA_REDIS_PASSWORD",
  redisSentinelPassword: "HA_REDIS_SENTINEL_PASSWORD",
  redisTls: "HA_REDIS_TLS",
  redisTlsCaFile: "HA_REDIS_TLS_CA_FILE",
  redisTlsInsecure: "HA_REDIS_TLS_INSECURE_SKIP_VERIFY",
  redisKeyPrefix: "HA_REDIS_KEY_PREFIX",
  leaseTtl: "HA_LEASE_TTL_SECONDS",
  s3Endpoint: "HA_S3_ENDPOINT",
  s3Region: "HA_S3_REGION",
  s3Bucket: "HA_S3_BUCKET",
  s3Path: "HA_S3_PATH",
  s3AccessKeyId: "HA_S3_ACCESS_KEY_ID",
  s3SecretAccessKey: "HA_S3_SECRET_ACCESS_KEY",
  s3ForcePathStyle: "HA_S3_FORCE_PATH_STYLE",
  syncInterval: "HA_SYNC_INTERVAL_SECONDS",
  followInterval: "HA_STANDBY_FOLLOW_INTERVAL_SECONDS",
  recoverFromLocal: "HA_RECOVER_FROM_LOCAL",
  litestreamBin: "HA_LITESTREAM_BIN",
} as const;

/** Set by the supervisor on the dashboard process it starts: "leader" or "standby". */
export const HA_ROLE_ENV = "HA_ROLE";
/** Set by the supervisor on the dashboard process: where it writes its status file. */
export const HA_STATUS_FILE_ENV = "HA_STATUS_FILE";

export const REDIS_MODES = ["standalone", "sentinel", "cluster"] as const;
export type HaRedisMode = (typeof REDIS_MODES)[number];

export const DEFAULT_KEY_PREFIX = "ingressi-ha";
export const DEFAULT_S3_PATH = "ingressi";
export const DEFAULT_S3_REGION = "us-east-1";
export const DEFAULT_LEASE_TTL_SECONDS = 15;
export const LEASE_TTL_LIMITS = { min: 5, max: 300 } as const;
export const DEFAULT_SYNC_INTERVAL_SECONDS = 1;
export const DEFAULT_FOLLOW_INTERVAL_SECONDS = 5;
const DEFAULT_DATABASE_PATH = "/app/data/ingressi.db";

const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KEY_PREFIX = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const MASTER_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const S3_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const REGION = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ACCESS_KEY_ID = /^[\x21-\x7e]{1,256}$/;
const PLAIN_SECRET = /^[^\r\n\0]{1,1024}$/;

export type HaRedisConfig = {
  mode: HaRedisMode;
  addresses: string[];
  masterName: string | null;
  db: number;
  username: string | null;
  password: string | null;
  sentinelPassword: string | null;
  tls: { enabled: boolean; insecureSkipVerify: boolean; caPem?: string };
  keyPrefix: string;
};

export type HaStorageConfig = {
  /** As configured (null: AWS S3, whose regional endpoint is derived). */
  endpoint: string | null;
  /** The S3 API origin the dashboard's own requests go to. */
  apiEndpoint: string;
  region: string;
  bucket: string;
  /** Prefix inside the bucket: cluster.json and replicas/<id>/ go under it. */
  path: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

export type HaConfig = {
  nodeId: string;
  redis: HaRedisConfig;
  leaseTtlMs: number;
  storage: HaStorageConfig;
  syncIntervalSeconds: number;
  /** 0: standbys keep no warm copy of the database. */
  followIntervalSeconds: number;
  /** The dashboard's SQLite file (never ":memory:"). */
  databasePath: string;
  /** Private working directory next to the database (status file, Litestream configs and socket, warm copy). */
  haDir: string;
  recoverFromLocal: boolean;
  litestreamBin: string;
};

/** The configuration is not usable; the message names the variable and is safe to show. */
export class HaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HaConfigError";
  }
}

type Env = Record<string, string | undefined>;

function value(env: Env, name: string): string | null {
  const raw = env[name];
  if (raw === undefined) return null;
  const text = raw.trim();
  return text.length > 0 ? text : null;
}

function flag(env: Env, name: string, fallback: boolean): boolean {
  const text = value(env, name);
  if (text === null) return fallback;
  if (/^(1|true|yes|on)$/i.test(text)) return true;
  if (/^(0|false|no|off)$/i.test(text)) return false;
  throw new HaConfigError(`${name} must be true or false`);
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const text = value(env, name);
  if (text === null) return fallback;
  if (!/^\d{1,6}$/.test(text)) throw new HaConfigError(`${name} must be a whole number from ${min} to ${max}`);
  const number = Number(text);
  if (number < min || number > max) throw new HaConfigError(`${name} must be a whole number from ${min} to ${max}`);
  return number;
}

function required(env: Env, name: string): string {
  const text = value(env, name);
  if (text === null) throw new HaConfigError(`${name} is required when HA_ENABLED is set`);
  return text;
}

/** HA_ENABLED is set to a true value. Never throws: an unreadable value counts as off here and fails in parseHaConfig. */
export function isHaEnabled(env: Env = process.env): boolean {
  try {
    return flag(env, HA_ENV.enabled, false);
  } catch {
    return false;
  }
}

/** Why HA_ENABLED is refused with a PostgreSQL database. */
export const HA_WITH_POSTGRES_MESSAGE =
  "HA_ENABLED replicates a SQLite database with Litestream and cannot be used with PostgreSQL: " +
  "unset HA_ENABLED, or set DATABASE_URL to a SQLite database";

/** Whether the dashboard is configured to run on PostgreSQL (DATABASE_URL or DATABASE_DIALECT). */
export function usesPostgres(env: Env): boolean {
  const dialect = value(env, "DATABASE_DIALECT")?.toLowerCase();
  return isPostgresUrl(value(env, "DATABASE_URL")) || dialect === "postgres" || dialect === "postgresql";
}

/** The SQLite file the dashboard uses, as src/lib/db.ts resolves it for absolute paths. */
export function resolveDatabasePath(env: Env): string {
  const explicit = value(env, "DATABASE_PATH");
  if (explicit) return isAbsolute(explicit) ? explicit : resolvePath(explicit);
  const url = value(env, "DATABASE_URL");
  if (url === null) return DEFAULT_DATABASE_PATH;
  if (url === ":memory:" || url === "file::memory:") {
    throw new HaConfigError("High availability needs the database in a file: DATABASE_URL must not be :memory:");
  }
  const path = url.startsWith("file:") ? url.slice("file:".length).replace(/^\/\/(localhost)?(?=\/)/, "") : url;
  return isAbsolute(path) ? path : resolvePath(path);
}

function readRedis(env: Env): HaRedisConfig {
  const modeText = value(env, HA_ENV.redisMode) ?? "standalone";
  if (!(REDIS_MODES as readonly string[]).includes(modeText)) {
    throw new HaConfigError(`${HA_ENV.redisMode} must be one of: ${REDIS_MODES.join(", ")}`);
  }
  const mode = modeText as HaRedisMode;
  const list = required(env, HA_ENV.redisAddresses)
    .split(/[\s,]+/)
    .filter(Boolean);
  if (list.length > 16) throw new HaConfigError(`${HA_ENV.redisAddresses} can list at most 16 servers`);
  let addresses: string[];
  try {
    addresses = [...new Set(list.map((item, index) => parseHostPort(item, `${HA_ENV.redisAddresses} entry ${index + 1}`)))];
  } catch (error) {
    if (error instanceof AddressError) throw new HaConfigError(error.message);
    throw error;
  }
  if (mode === "standalone" && addresses.length !== 1) {
    throw new HaConfigError(`${HA_ENV.redisAddresses} must name exactly one server in the standalone mode`);
  }
  const masterName = value(env, HA_ENV.redisMasterName);
  if (mode === "sentinel") {
    if (!masterName) throw new HaConfigError(`${HA_ENV.redisMasterName} is required in the sentinel mode`);
    if (!MASTER_NAME.test(masterName)) throw new HaConfigError(`${HA_ENV.redisMasterName} contains characters that are not allowed`);
  }
  const db = integer(env, HA_ENV.redisDb, 0, 0, 255);
  if (mode === "cluster" && db !== 0) throw new HaConfigError(`${HA_ENV.redisDb} must be 0 in the cluster mode`);
  const username = value(env, HA_ENV.redisUsername);
  if (username !== null && !/^[\x21-\x7e]{1,128}$/.test(username)) {
    throw new HaConfigError(`${HA_ENV.redisUsername} contains characters that are not allowed`);
  }
  const password = env[HA_ENV.redisPassword] ? env[HA_ENV.redisPassword]! : null;
  if (password !== null && !PLAIN_SECRET.test(password)) throw new HaConfigError(`${HA_ENV.redisPassword} is not usable`);
  const sentinelPassword = env[HA_ENV.redisSentinelPassword] ? env[HA_ENV.redisSentinelPassword]! : null;
  if (sentinelPassword !== null && !PLAIN_SECRET.test(sentinelPassword)) {
    throw new HaConfigError(`${HA_ENV.redisSentinelPassword} is not usable`);
  }
  const tlsEnabled = flag(env, HA_ENV.redisTls, false);
  const insecureSkipVerify = tlsEnabled && flag(env, HA_ENV.redisTlsInsecure, false);
  let caPem: string | undefined;
  const caFile = value(env, HA_ENV.redisTlsCaFile);
  if (tlsEnabled && caFile) {
    try {
      caPem = readFileSync(caFile, "utf8");
    } catch {
      throw new HaConfigError(`${HA_ENV.redisTlsCaFile} cannot be read`);
    }
    if (!caPem.includes("-----BEGIN CERTIFICATE-----")) throw new HaConfigError(`${HA_ENV.redisTlsCaFile} must hold PEM certificates`);
  }
  const keyPrefix = value(env, HA_ENV.redisKeyPrefix) ?? DEFAULT_KEY_PREFIX;
  if (keyPrefix.length > 200 || !KEY_PREFIX.test(keyPrefix) || keyPrefix.split("/").some((part) => part === "." || part === "..")) {
    throw new HaConfigError(`${HA_ENV.redisKeyPrefix} may contain letters, digits, ".", "_", "-" and "/" between segments`);
  }
  return {
    mode,
    addresses,
    masterName: mode === "sentinel" ? masterName : null,
    db,
    username,
    password,
    sentinelPassword: mode === "sentinel" ? sentinelPassword : null,
    tls: { enabled: tlsEnabled, insecureSkipVerify, ...(caPem ? { caPem } : {}) },
    keyPrefix,
  };
}

function readEndpoint(env: Env): string | null {
  const text = value(env, HA_ENV.s3Endpoint);
  if (text === null) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new HaConfigError(`${HA_ENV.s3Endpoint} must be a URL such as https://s3.example.com`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new HaConfigError(`${HA_ENV.s3Endpoint} must use https or http`);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new HaConfigError(`${HA_ENV.s3Endpoint} must be an origin only (scheme, host and port), without a path or credentials`);
  }
  return url.origin;
}

function readStorage(env: Env): HaStorageConfig {
  const endpoint = readEndpoint(env);
  const region = value(env, HA_ENV.s3Region) ?? DEFAULT_S3_REGION;
  if (!REGION.test(region)) throw new HaConfigError(`${HA_ENV.s3Region} contains characters that are not allowed`);
  const bucket = required(env, HA_ENV.s3Bucket);
  if (!BUCKET.test(bucket)) throw new HaConfigError(`${HA_ENV.s3Bucket} must be a bucket name: lower-case letters, digits, "." and "-"`);
  const path = (value(env, HA_ENV.s3Path) ?? DEFAULT_S3_PATH).replace(/^\/+|\/+$/g, "");
  if (path.length === 0 || path.length > 200 || !S3_PATH.test(path) || path.split("/").some((part) => part === "." || part === "..")) {
    throw new HaConfigError(`${HA_ENV.s3Path} may contain letters, digits, ".", "_", "-" and "/" between segments`);
  }
  const accessKeyId = required(env, HA_ENV.s3AccessKeyId);
  if (!ACCESS_KEY_ID.test(accessKeyId)) throw new HaConfigError(`${HA_ENV.s3AccessKeyId} contains characters that are not allowed`);
  const secretAccessKey = env[HA_ENV.s3SecretAccessKey] ?? "";
  if (secretAccessKey.length === 0) throw new HaConfigError(`${HA_ENV.s3SecretAccessKey} is required when HA_ENABLED is set`);
  if (!PLAIN_SECRET.test(secretAccessKey)) throw new HaConfigError(`${HA_ENV.s3SecretAccessKey} is not usable`);
  return {
    endpoint,
    apiEndpoint: endpoint ?? `https://s3.${region}.amazonaws.com`,
    region,
    bucket,
    path,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: flag(env, HA_ENV.s3ForcePathStyle, endpoint !== null),
  };
}

/**
 * The cluster configuration, or null when HA_ENABLED is not set. Throws
 * HaConfigError when HA is on but a variable is missing or not valid: a node
 * that is meant to be part of a cluster must never start on its own.
 */
export function parseHaConfig(env: Env = process.env): HaConfig | null {
  if (!flag(env, HA_ENV.enabled, false)) return null;
  // This cluster replicates the SQLite file with Litestream (D15).
  if (usesPostgres(env)) throw new HaConfigError(HA_WITH_POSTGRES_MESSAGE);
  const nodeId = value(env, HA_ENV.nodeId) ?? hostname();
  if (!NODE_ID.test(nodeId)) {
    throw new HaConfigError(`${HA_ENV.nodeId} must be 1 to 64 letters, digits, ".", "_" or "-" (set it when the host name is not)`);
  }
  if (value(env, "INSTANCE_MODE") === "slave") {
    throw new HaConfigError("High availability runs the master or a standalone dashboard; a sync slave (INSTANCE_MODE=slave) cannot be a cluster");
  }
  const databasePath = resolveDatabasePath(env);
  return {
    nodeId,
    redis: readRedis(env),
    leaseTtlMs: integer(env, HA_ENV.leaseTtl, DEFAULT_LEASE_TTL_SECONDS, LEASE_TTL_LIMITS.min, LEASE_TTL_LIMITS.max) * 1000,
    storage: readStorage(env),
    syncIntervalSeconds: integer(env, HA_ENV.syncInterval, DEFAULT_SYNC_INTERVAL_SECONDS, 1, 60),
    followIntervalSeconds: integer(env, HA_ENV.followInterval, DEFAULT_FOLLOW_INTERVAL_SECONDS, 0, 300),
    databasePath,
    haDir: join(dirname(databasePath), "ha"),
    recoverFromLocal: flag(env, HA_ENV.recoverFromLocal, false),
    litestreamBin: value(env, HA_ENV.litestreamBin) ?? "litestream",
  };
}

/** What the API and the High availability page show of the configuration: no secrets. */
export function toClusterConfigView(config: HaConfig): ClusterConfigView {
  return {
    redis: {
      mode: config.redis.mode,
      addresses: config.redis.addresses,
      keyPrefix: config.redis.keyPrefix,
      tls: config.redis.tls.enabled,
      hasPassword: config.redis.password !== null,
    },
    storage: {
      endpoint: config.storage.endpoint,
      region: config.storage.region,
      bucket: config.storage.bucket,
      path: config.storage.path,
    },
    leaseTtlSeconds: config.leaseTtlMs / 1000,
    syncIntervalSeconds: config.syncIntervalSeconds,
    followIntervalSeconds: config.followIntervalSeconds,
  };
}
