// SPDX-License-Identifier: Elastic-2.0
/**
 * The supervisor's direct work on this node's SQLite file, before the
 * dashboard process opens it: putting a restored copy in place, switching the
 * file to WAL (Litestream needs it), and reading the installed license when
 * the cluster is set up from this node.
 */
import { Database } from "bun:sqlite";
import { closeSync, existsSync, fsyncSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { canConfigure, evaluateLicense, type LicenseCheckInput } from "@/ee/licensing/license";
import { getTrustedLicenseKeys } from "@/ee/licensing/public-keys";
import { HIGH_AVAILABILITY_FEATURE } from "../types";
import { databaseFiles, litestreamMetaPath } from "./litestream";

/** The settings key the license is stored under (ee/licensing/store.ts). */
const LICENSE_SETTING_KEY = "license";
/** LICENSE_CHECK_SETTING_KEY of ee/licensing/online-check-state.ts (not imported: it pulls in the app database). */
const LICENSE_CHECK_SETTING_KEY = "license_check";

export interface LocalDatabase {
  /** A database file with content exists at `path`. */
  exists(path: string): boolean;
  /** The license installed in the database at `path` lets an administrator set up high availability. */
  licenseAllowsHa(path: string, now: Date): boolean;
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

/** The online key's stored statements and first-seen times (evaluateLicense validates every entry itself). */
function storedCheckInput(value: unknown): LicenseCheckInput {
  try {
    const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : null;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const record = parsed as { statements?: unknown; firstSeen?: unknown };
    const map = (entry: unknown) =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry) ? (entry as Record<string, string>) : undefined;
    return { statements: map(record.statements), firstSeen: map(record.firstSeen) };
  } catch {
    return {};
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

  licenseAllowsHa(path, now) {
    let db: InstanceType<typeof Database> | null = null;
    try {
      db = new Database(path, { readonly: true });
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(LICENSE_SETTING_KEY) as { value?: unknown } | null;
      const key = typeof row?.value === "string" ? (JSON.parse(row.value) as unknown) : null;
      const checkRow = db.prepare("SELECT value FROM settings WHERE key = ?").get(LICENSE_CHECK_SETTING_KEY) as { value?: unknown } | null;
      const state = evaluateLicense(
        typeof key === "string" && key.length > 0 ? key : null,
        getTrustedLicenseKeys(),
        now,
        storedCheckInput(checkRow?.value)
      );
      return canConfigure(state, HIGH_AVAILABILITY_FEATURE);
    } catch {
      return false;
    } finally {
      db?.close();
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
