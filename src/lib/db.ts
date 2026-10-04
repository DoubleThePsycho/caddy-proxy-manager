/**
 * The application database (src/lib/db/README.md).
 *
 * - `appDb`, also the default export: the asynchronous, dialect-neutral
 *   facade (src/lib/db/executor.ts) on SQLite or PostgreSQL. Await every
 *   query; inside `appDb.transaction(fn)` it runs in that transaction.
 * - `sqlite`: the raw SQLite connection (it throws when used on
 *   PostgreSQL); `purgeDeletedDatabaseContent`: the VACUUM run at start-up,
 *   through the executor's gate (nothing on PostgreSQL).
 *
 * The synchronous Drizzle instance on the same connection is no longer
 * exported: only the schema migrations and legacy repairs in
 * src/lib/db/sqlite.ts use it, when the database is opened.
 *
 * On SQLite, opening this module opens the database and runs the schema
 * migrations; on PostgreSQL the pool connects on first use and the schema
 * migrations run in runDatabaseStartup() (src/lib/db/startup.ts), with the
 * one-time data migrations, from src/instrumentation.ts.
 */
import * as schema from "./db/schema";
import { appDb } from "./db/executor";

export { sqlite, restrictDatabaseFileModes } from "./db/sqlite";
export { appDb };
export { purgeDeletedDatabaseContent } from "./db/startup";
export { schema };
export default appDb;

export function nowIso(): string {
  return new Date().toISOString();
}

export function toIso(value: string | Date | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
