/**
 * Preparing a PostgreSQL database at start-up (runDatabaseStartup in
 * startup.ts): on a connection of its own, under the migration advisory
 * lock (so replicas starting together migrate once, one after the other),
 *
 * 1. refuse a server older than PostgreSQL 16 (D1);
 * 2. refuse a database that does not compare and classify text byte by
 *    byte (UTF8 with the C collation and character classification, D2), as
 *    SQLite does: ordering, LIKE and lower() would differ;
 * 3. refuse a database a newer version of Ingressi migrated (D8): its schema
 *    may not work with this code; to upgrade, every replica is stopped
 *    first;
 * 4. apply the migrations in drizzle-pg/;
 * 5. run `then` (the one-time data migrations) before letting the next
 *    replica in.
 */
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";
import { ADVISORY_LOCK_NAMESPACE, MIGRATE_LOCK_ID, watchHeldConnection } from "./postgres";

/** PostgreSQL 16 (server_version_num). */
export const MINIMUM_SERVER_VERSION_NUM = 160000;

/** The PostgreSQL migrations, next to drizzle/ (docker/web/Dockerfile copies both). */
export const PG_MIGRATIONS_FOLDER = resolvePath(process.cwd(), "drizzle-pg");

/** The database cannot be used by this version; the message says why and what to do. */
export class DatabaseStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseStartupError";
  }
}

/** What the start-up checks read from the server. */
export interface PostgresDatabaseFacts {
  databaseName: string;
  serverVersionNum: number;
  serverVersion: string;
  encoding: string;
  collate: string;
  ctype: string;
  /** pg_database.datlocprovider: c (libc), i (ICU) or b (builtin, PostgreSQL 17). */
  provider: string;
  /** The ICU or builtin locale, when the provider is not libc. */
  locale: string | null;
}

const C_LOCALES = new Set(["C", "POSIX"]);

function createDatabaseHint(name: string): string {
  return (
    `create the database with CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8' ` +
    "LOCALE_PROVIDER libc LC_COLLATE 'C' LC_CTYPE 'C'"
  );
}

/** Why this database cannot be used (none: it can). */
export function postgresCompatibilityProblems(facts: PostgresDatabaseFacts): string[] {
  const problems: string[] = [];
  if (!(facts.serverVersionNum >= MINIMUM_SERVER_VERSION_NUM)) {
    problems.push(`PostgreSQL ${facts.serverVersion} is too old: Ingressi needs PostgreSQL 16 or later`);
  }
  const localeOk =
    facts.encoding.toUpperCase() === "UTF8"
    && C_LOCALES.has(facts.collate)
    && C_LOCALES.has(facts.ctype)
    && (facts.provider === "c" || (facts.provider === "b" && facts.locale === "C"));
  if (!localeOk) {
    const provider = { c: "libc", i: "ICU", b: "builtin" }[facts.provider] ?? facts.provider;
    problems.push(
      `the database "${facts.databaseName}" uses encoding ${facts.encoding}, collation ${facts.collate}, ` +
        `character classification ${facts.ctype} (${provider} locale provider${facts.locale ? ` ${facts.locale}` : ""}); ` +
        "Ingressi needs UTF8 with the C collation and character classification so text sorts and matches " +
        `as it does on SQLite: ${createDatabaseHint(facts.databaseName)}, then copy the data into it`
    );
  }
  return problems;
}

/** Reads the facts the checks need. */
export async function readPostgresDatabaseFacts(connection: Pick<pg.ClientBase, "query">): Promise<PostgresDatabaseFacts> {
  const { rows } = await connection.query<{
    name: string;
    version_num: string | number;
    version: string;
    encoding: string;
    info: Record<string, unknown>;
  }>(
    `SELECT d.datname AS name, current_setting('server_version_num') AS version_num,
            current_setting('server_version') AS version, pg_encoding_to_char(d.encoding) AS encoding,
            to_jsonb(d) - 'datacl' AS info
       FROM pg_database d WHERE d.datname = current_database()`
  );
  const row = rows[0];
  if (!row) throw new DatabaseStartupError("The current database is not listed in pg_database");
  const info = row.info;
  const text = (key: string): string | null => (typeof info[key] === "string" ? (info[key] as string) : null);
  return {
    databaseName: row.name,
    serverVersionNum: Number(row.version_num),
    serverVersion: row.version,
    encoding: row.encoding,
    collate: text("datcollate") ?? "",
    ctype: text("datctype") ?? "",
    provider: text("datlocprovider") ?? "c",
    // PostgreSQL 17 calls it datlocale, 15 and 16 daticulocale.
    locale: text("datlocale") ?? text("daticulocale"),
  };
}

/** The `when` of the newest migration in `migrationsFolder` (what drizzle's migrator records as created_at). */
export function newestMigrationWhen(migrationsFolder = PG_MIGRATIONS_FOLDER): number {
  const journal = JSON.parse(readFileSync(resolvePath(migrationsFolder, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ when: number }>;
  };
  return Math.max(0, ...journal.entries.map((entry) => entry.when));
}

/** The created_at of the newest migration the database records, or null for a database never migrated. */
async function newestAppliedMigration(connection: Pick<pg.ClientBase, "query">): Promise<number | null> {
  const { rows: exists } = await connection.query<{ present: boolean }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present"
  );
  if (!exists[0]?.present) return null;
  const { rows } = await connection.query<{ newest: string | number | null }>(
    "SELECT max(created_at) AS newest FROM drizzle.__drizzle_migrations"
  );
  const newest = rows[0]?.newest;
  return newest === null || newest === undefined ? null : Number(newest);
}

export interface PreparePostgresOptions {
  migrationsFolder?: string;
  /** Runs after the migrations, still under the migration lock (the one-time data migrations). */
  then?: () => Promise<void>;
}

/**
 * Checks and migrates the database `pool` connects to (see the module
 * comment). Throws DatabaseStartupError when it cannot be used.
 */
export async function preparePostgresDatabase(
  pool: Pick<pg.Pool, "connect">,
  options: PreparePostgresOptions = {}
): Promise<void> {
  const migrationsFolder = options.migrationsFolder ?? PG_MIGRATIONS_FOLDER;
  const connection = await pool.connect();
  const unwatch = watchHeldConnection(connection, "the database start-up");
  let broken: Error | undefined;
  let locked = false;
  try {
    const problems = postgresCompatibilityProblems(await readPostgresDatabaseFacts(connection));
    if (problems.length > 0) {
      throw new DatabaseStartupError(`The PostgreSQL database cannot be used: ${problems.join("; ")}.`);
    }

    // Migrations may take long, and may wait for a replica that is migrating.
    await connection.query("SET statement_timeout = 0; SET lock_timeout = 0");
    await connection.query(`SELECT pg_advisory_lock(${ADVISORY_LOCK_NAMESPACE}, ${MIGRATE_LOCK_ID})`);
    locked = true;

    const applied = await newestAppliedMigration(connection);
    const known = newestMigrationWhen(migrationsFolder);
    if (applied !== null && applied > known) {
      throw new DatabaseStartupError(
        `The PostgreSQL database was migrated by a newer version of Ingressi (its newest migration is from ` +
          `${new Date(applied).toISOString()}, this version knows migrations up to ${new Date(known).toISOString()}). ` +
          "Run that version or a newer one; to upgrade, stop every replica, then start the new version."
      );
    }

    await migrate(drizzle(connection), { migrationsFolder });
    if (options.then) await options.then();
  } catch (error) {
    if (!(error instanceof DatabaseStartupError)) {
      // Whatever state the session is in, it is not reused.
      broken = error instanceof Error ? error : new Error(String(error));
    }
    throw error;
  } finally {
    if (locked && !broken) {
      try {
        await connection.query(`SELECT pg_advisory_unlock(${ADVISORY_LOCK_NAMESPACE}, ${MIGRATE_LOCK_ID})`);
      } catch (error) {
        broken = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (!broken) {
      try {
        await connection.query("RESET statement_timeout; RESET lock_timeout");
      } catch (error) {
        broken = error instanceof Error ? error : new Error(String(error));
      }
    }
    // A broken connection is closed, which also releases the lock on the server.
    unwatch();
    connection.release(broken);
  }
}
