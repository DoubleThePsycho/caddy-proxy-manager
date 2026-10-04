/**
 * The PostgreSQL connection pool (src/lib/db/README.md): node-postgres,
 * configured from the environment.
 *
 * - DATABASE_URL: postgres://user:password@host:5432/database. `sslmode`
 *   follows libpq: disable, require (encrypted, server not verified),
 *   verify-ca (encrypted, certificate chain verified) or verify-full (chain
 *   and host name verified). `sslrootcert`, `sslcert` and `sslkey` name
 *   files, as with libpq. allow and prefer are refused: node-postgres cannot
 *   fall back to a plaintext connection, and silently not encrypting is
 *   worse than failing.
 * - DATABASE_SSL_CA_FILE: the CA certificate(s) the server's certificate must
 *   chain to (PEM). Without an sslmode it means verify-full.
 * - DATABASE_POOL_MAX: connections per process for queries (default 10, at
 *   least 2). Cluster locks (locks.ts) hold connections of a pool of their
 *   own, opened as locks are taken (at most LOCK_POOL_MAX).
 *
 * The pool is created on first use and connects lazily, so `next build`
 * (which runs on SQLite) never opens a connection. Every connection starts
 * with the session settings below, and every query goes through the type
 * parsers below, so rows look as they do on SQLite: 64-bit integers and
 * numerics as numbers, booleans as booleans, timestamps as ISO 8601 text.
 */
import { readFileSync } from "node:fs";
import type { ConnectionOptions } from "node:tls";
import pg from "pg";

// ── Session settings ──

/** A statement that runs longer is cancelled (milliseconds). */
export const STATEMENT_TIMEOUT_MS = 60_000;
/** Waiting longer for a lock (a row, a table, the write lock) fails the statement (milliseconds). */
export const LOCK_TIMEOUT_MS = 30_000;
/** A session idle inside an open transaction longer than this is ended by the server (milliseconds). */
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;
/** application_name: what pg_stat_activity shows for the application's connections. */
export const APPLICATION_NAME = "ingressi";

export const DEFAULT_POOL_MAX = 10;
const POOL_MAX_LIMITS = { min: 2, max: 1000 } as const;

// ── Advisory locks ──

/**
 * The application's own advisory locks use the two-key form
 * pg_advisory_lock(namespace, id), which never collides with the one-key
 * form withClusterLock uses (pg_advisory_lock(hashtext(name))).
 */
export const ADVISORY_LOCK_NAMESPACE = 1_768_843_115;
/** Held by every writing transaction until it ends (D4: writers are serialised, as on SQLite). */
export const WRITE_LOCK_ID = 1;
/** Held while the schema migrations and the one-time data migrations run. */
export const MIGRATE_LOCK_ID = 2;
/** Held, for as long as it leads, by the session of the replica that runs the background jobs (leader.ts). */
export const LEADER_LOCK_ID = 3;

// ── Type parsers ──

const { builtins } = pg.types;

/** A 64-bit integer (count(*), sum of integers, bigint columns) as a number, as SQLite returns it. */
function parseInteger(value: string): number {
  return Number(value);
}

const TIMESTAMP = /^(\d{4,})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:([+-])(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?)?$/;

/**
 * A timestamp as ISO 8601 text in UTC (what nowIso() writes). Text without
 * an offset (timestamp without time zone) is read as UTC. Values a Date
 * cannot hold (infinity, BC dates) are returned as the server wrote them.
 */
export function parseTimestamp(value: string): string {
  const match = TIMESTAMP.exec(value);
  if (!match) return value;
  const [, year, month, day, hour, minute, second, fraction, sign, offsetHours, offsetMinutes, offsetSeconds] = match;
  const milliseconds = fraction ? Math.floor(Number(fraction) * 1000) : 0;
  const date = new Date(Date.UTC(2000, Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), milliseconds));
  // Date.UTC reads years below 100 as 19xx.
  date.setUTCFullYear(Number(year));
  if (sign) {
    const offset = (Number(offsetHours) * 3600 + Number(offsetMinutes ?? 0) * 60 + Number(offsetSeconds ?? 0)) * 1000;
    date.setTime(date.getTime() + (sign === "+" ? -offset : offset));
  }
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

const TEXT_PARSERS = new Map<number, (value: string) => unknown>([
  [builtins.INT8, parseInteger],
  [builtins.NUMERIC, parseInteger],
  [builtins.BOOL, (value: string) => value === "t"],
  [builtins.TIMESTAMPTZ, parseTimestamp],
  [builtins.TIMESTAMP, parseTimestamp],
  [builtins.DATE, (value: string) => value],
]);

/**
 * The type parsers of every query the application runs (the pool's and,
 * through the executor, Drizzle's): see the module comment.
 */
export const PG_TYPES: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: "text" | "binary") => {
    if (format !== "binary") {
      const parser = TEXT_PARSERS.get(oid);
      if (parser) return parser;
    }
    return pg.types.getTypeParser(oid, format as "text");
  }) as pg.CustomTypesConfig["getTypeParser"],
};

// ── Configuration ──

/** A configuration that cannot work: the message names the variable, never its value. */
export class PostgresConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgresConfigError";
  }
}

export type PostgresEnv = Readonly<Record<string, string | undefined>>;

/** URL parameters this module handles itself rather than node-postgres. */
const TLS_URL_PARAMETERS = ["sslmode", "sslrootcert", "sslcert", "sslkey", "ssl", "uselibpqcompat", "sslnegotiation"];

function readFile(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unreadable";
    throw new PostgresConfigError(`Cannot read ${what} (${code})`);
  }
}

function readTls(url: URL, env: PostgresEnv): false | ConnectionOptions {
  const mode = url.searchParams.get("sslmode")?.trim().toLowerCase() || null;
  const sslParameter = url.searchParams.get("ssl")?.trim().toLowerCase() || null;
  const caFile = env.DATABASE_SSL_CA_FILE?.trim() || url.searchParams.get("sslrootcert")?.trim() || null;
  const certFile = url.searchParams.get("sslcert")?.trim() || null;
  const keyFile = url.searchParams.get("sslkey")?.trim() || null;

  if (mode === "allow" || mode === "prefer") {
    throw new PostgresConfigError(
      `DATABASE_URL: sslmode=${mode} is not supported (it may fall back to an unencrypted connection); ` +
        "use disable, require, verify-ca or verify-full"
    );
  }
  if (mode !== null && !["disable", "require", "verify-ca", "verify-full"].includes(mode)) {
    throw new PostgresConfigError("DATABASE_URL: sslmode must be disable, require, verify-ca or verify-full");
  }
  if (mode === "disable") {
    if (caFile || certFile || keyFile) {
      throw new PostgresConfigError("DATABASE_URL has sslmode=disable but a certificate is configured; remove one of them");
    }
    return false;
  }
  if (mode === null && !caFile && !certFile && !keyFile && sslParameter !== "true" && sslParameter !== "1") {
    return false;
  }
  if ((certFile === null) !== (keyFile === null)) {
    throw new PostgresConfigError("DATABASE_URL: sslcert and sslkey must be given together");
  }

  const options: ConnectionOptions = {};
  if (caFile) options.ca = readFile(caFile, "the database CA certificate (DATABASE_SSL_CA_FILE or sslrootcert)");
  if (certFile && keyFile) {
    options.cert = readFile(certFile, "the database client certificate (sslcert)");
    options.key = readFile(keyFile, "the database client key (sslkey)");
  }
  // libpq: require verifies nothing, unless a root certificate is given
  // (then it behaves as verify-ca); without a mode, a CA file means verify-full.
  const effective = mode === "require" ? (caFile ? "verify-ca" : "require") : (mode ?? "verify-full");
  if (effective === "require") {
    options.rejectUnauthorized = false;
  } else {
    options.rejectUnauthorized = true;
    // verify-ca: the chain, not the host name.
    if (effective === "verify-ca") options.checkServerIdentity = () => undefined;
  }
  return options;
}

function readPoolMax(env: PostgresEnv): number {
  const text = env.DATABASE_POOL_MAX?.trim();
  if (!text) return DEFAULT_POOL_MAX;
  const value = Number(text);
  if (!/^\d+$/.test(text) || value < POOL_MAX_LIMITS.min || value > POOL_MAX_LIMITS.max) {
    throw new PostgresConfigError(
      `DATABASE_POOL_MAX must be a whole number from ${POOL_MAX_LIMITS.min} to ${POOL_MAX_LIMITS.max}`
    );
  }
  return value;
}

/** The pool configuration for `env` (process.env by default). Throws PostgresConfigError. */
export function readPostgresConfig(env: PostgresEnv = process.env): pg.PoolConfig {
  const raw = env.DATABASE_URL?.trim();
  if (!raw) throw new PostgresConfigError("DATABASE_URL must be a postgres:// URL to run on PostgreSQL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PostgresConfigError("DATABASE_URL is not a valid postgres:// URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new PostgresConfigError("DATABASE_URL must start with postgres:// or postgresql://");
  }

  const ssl = readTls(url, env);
  // Settings for every session, sent with the connection request. Options
  // already in the URL are kept; the time zone is always UTC and dates are
  // written in ISO format (what the timestamp parser reads).
  const urlOptions = url.searchParams.get("options")?.trim() ?? "";
  for (const name of [...TLS_URL_PARAMETERS, "options"]) url.searchParams.delete(name);

  return {
    connectionString: url.toString(),
    ssl,
    max: readPoolMax(env),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
    application_name: APPLICATION_NAME,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    lock_timeout: LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
    options: [urlOptions, "-c TimeZone=UTC -c DateStyle=ISO"].filter(Boolean).join(" "),
    types: PG_TYPES,
  };
}

/** A pool for `config`, with an error listener (an idle connection that fails is replaced, not fatal). */
export function createPostgresPool(config: pg.PoolConfig = readPostgresConfig()): pg.Pool {
  const pool = new pg.Pool(config);
  pool.on("error", (error) => {
    console.error("[db] A PostgreSQL connection failed while idle; the pool opens a new one when needed:", error.message);
  });
  return pool;
}

/**
 * Listens for errors on a connection held outside the pool (a transaction,
 * a lock, the migrations): the server may end it (a timeout, a restart), and
 * node-postgres reports that as an "error" event, which with no listener
 * would end the process. The next query on the connection fails instead.
 * Returns the function that stops listening (call it before releasing).
 */
export function watchHeldConnection(connection: pg.PoolClient, what: string): () => void {
  const listener = (error: Error) => {
    console.error(`[db] The PostgreSQL connection of ${what} failed:`, error.message);
  };
  connection.on("error", listener);
  return () => {
    connection.removeListener("error", listener);
  };
}

type GlobalPgState = typeof globalThis & { __ingressiPgPool?: pg.Pool };
const globalPg = globalThis as GlobalPgState;

/** The application's pool, created on first use from process.env (shared across module reloads). */
export function getPostgresPool(): pg.Pool {
  return (globalPg.__ingressiPgPool ??= createPostgresPool());
}
