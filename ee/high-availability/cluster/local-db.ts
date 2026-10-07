// SPDX-License-Identifier: Elastic-2.0
/**
 * The supervisor's direct work on this node's SQLite file, before the
 * dashboard process opens it: putting a restored copy in place and switching
 * the file to WAL (Litestream needs it).
 */
import { Database } from "bun:sqlite";
import { closeSync, existsSync, fsyncSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { databaseFiles, litestreamMetaPath } from "./litestream";

export interface LocalDatabase {
  /** A database file with content exists at `path`. */
  exists(path: string): boolean;
  /** Replaces the database at `livePath` (and its journal files) with the restored file at `restoredPath`. */
  install(restoredPath: string, livePath: string): void;
  /** Forgets Litestream's local state for `livePath`, so replication starts afresh in a new replica. */
  resetReplicationState(livePath: string): void;
  /** Opens the database once, recovering its WAL, and switches it to WAL mode. */
  prepareForReplication(livePath: string): void;
}

function fsyncDirectory(path: string) {
  let fd: number | null = null;
  try {
    fd = openSync(dirname(path), "r");
    fsyncSync(fd);
  } catch {
    // Not every filesystem allows syncing a directory.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export const localDatabase: LocalDatabase = {
  exists(path) {
    try {
      return statSync(path).isFile() && statSync(path).size > 0;
    } catch {
      return false;
    }
  },

  install(restoredPath, livePath) {
    for (const file of databaseFiles(livePath)) rmSync(file, { force: true });
    renameSync(restoredPath, livePath);
    fsyncDirectory(livePath);
  },

  resetReplicationState(livePath) {
    rmSync(litestreamMetaPath(livePath), { recursive: true, force: true });
  },

  prepareForReplication(livePath) {
    const db = new Database(livePath);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA journal_mode = WAL");
    } finally {
      db.close();
    }
    if (!existsSync(livePath)) throw new Error("the database file is missing after opening it");
  },
};
