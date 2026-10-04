/**
 * Where the SQLite database file is, for the command-line tools that open a
 * database without the application's database modules (the copy to
 * PostgreSQL, the break-glass tool): a location as DATABASE_URL gives it,
 * read as src/lib/db/sqlite.ts reads DATABASE_URL, except that it must name
 * a file on this host.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DATABASE_FILE_NAME, LEGACY_DATABASE_FILE_NAME } from "../db-file";
import { isPostgresUrl } from "./dialect";

/** The location names no SQLite file on this host: a file on another host ("remote"), or no file (":memory:", empty). */
export class SqliteLocationError extends Error {
  constructor(
    readonly kind: "remote" | "not-a-file",
    message: string
  ) {
    super(message);
    this.name = "SqliteLocationError";
  }
}

/** A SQLite location (a path, file:./relative or a file: URL) as an absolute path. */
export function sqliteFilePath(location: string, cwd: string = process.cwd()): string {
  const value = location.trim();
  let path = value;
  if (value.startsWith("file:./") || value.startsWith("file:../")) {
    path = value.slice("file:".length);
  } else if (value.startsWith("file:")) {
    let url: URL | null = null;
    try {
      url = new URL(value);
    } catch {
      path = value.slice("file:".length);
    }
    if (url) {
      if (url.host && url.host !== "localhost") throw new SqliteLocationError("remote", "A SQLite file on another host is not supported.");
      path = decodeURIComponent(url.pathname);
    }
  }
  if (path === "" || path === ":memory:") throw new SqliteLocationError("not-a-file", "The location must name a SQLite database file, not :memory:.");
  return resolve(cwd, path);
}

/**
 * The file DATABASE_URL names when it is a SQLite location; otherwise
 * ./data/ingressi.db, or the file from before the rename when only that one
 * exists.
 */
export function defaultSqliteFile(env: Readonly<Record<string, string | undefined>> = process.env, cwd: string = process.cwd()): string {
  const url = env.DATABASE_URL?.trim();
  if (url && !isPostgresUrl(url)) return sqliteFilePath(url, cwd);
  const current = resolve(cwd, "data", DATABASE_FILE_NAME);
  const legacy = resolve(cwd, "data", LEGACY_DATABASE_FILE_NAME);
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}
