import { existsSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** File name of the SQLite database. */
export const DATABASE_FILE_NAME = "ingressi.db";

/** File name of the SQLite database before the rename to Ingressi. */
export const LEGACY_DATABASE_FILE_NAME = "caddy-proxy-manager.db";

const JOURNAL_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

/**
 * Installs from before the rename keep their database as
 * caddy-proxy-manager.db. When the configured database is an ingressi.db that
 * does not exist yet and the old file sits in the same directory, move the old
 * file and its journal files to the new name, so switching DATABASE_URL to the
 * new default keeps the data. Returns whether a file was moved.
 *
 * The journal files go first: if the process stops halfway, the main file is
 * still under its old name and the next start finishes the move.
 */
export function adoptLegacyDatabaseFile(pathname: string): boolean {
  if (pathname === ":memory:" || basename(pathname) !== DATABASE_FILE_NAME || existsSync(pathname)) {
    return false;
  }
  const legacy = join(dirname(pathname), LEGACY_DATABASE_FILE_NAME);
  if (!existsSync(legacy)) {
    return false;
  }
  for (const suffix of JOURNAL_SUFFIXES) {
    if (existsSync(`${legacy}${suffix}`) && !existsSync(`${pathname}${suffix}`)) {
      renameSync(`${legacy}${suffix}`, `${pathname}${suffix}`);
    }
  }
  renameSync(legacy, pathname);
  return true;
}
