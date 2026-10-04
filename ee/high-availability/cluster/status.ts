// SPDX-License-Identifier: Elastic-2.0
/**
 * The status file: written by the supervisor after every state change and
 * renewal, read by the dashboard process of the same container (the health
 * endpoint, the cluster API and page, and the leader watchdog in
 * ee/high-availability/role.ts). Holds no secrets.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { NODE_ROLES, type NodeStatusFile } from "./types";

const MAX_STATUS_BYTES = 256 * 1024;

export function writeStatusFile(path: string, status: NodeStatusFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(status), { mode: 0o600 });
  renameSync(temporary, path);
}

/** The status, or null when the file is missing or not one. */
export function readStatusFile(path: string): NodeStatusFile | null {
  try {
    const text = readFileSync(path, "utf8");
    if (text.length > MAX_STATUS_BYTES) return null;
    const parsed = JSON.parse(text) as NodeStatusFile;
    if (parsed?.version !== 1 || typeof parsed.nodeId !== "string" || !(NODE_ROLES as readonly string[]).includes(parsed.role)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
