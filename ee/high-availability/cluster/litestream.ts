// SPDX-License-Identifier: Elastic-2.0
/**
 * Litestream (pinned in docker/web/Dockerfile) as child processes of the
 * supervisor:
 *
 * - `replicate` on the leader streams the database to its own replica
 *   directory and serves a control socket, whose /list reports when the last
 *   sync reached object storage;
 * - `restore` on a node being promoted builds the newest copy of the replica
 *   the cluster points to;
 * - `restore -f` (follow) on a standby keeps a read-only warm copy current.
 *
 * Configuration files are generated here (0600, in the private HA directory)
 * with environment expansion off; the storage keys only reach Litestream
 * through its environment, never a file or a log line.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import type { HaConfig } from "./config";

export type ExitResult = { code: number | null; signal: string | null };

export type ProcessHandle = {
  readonly exited: Promise<ExitResult>;
  kill(signal: NodeJS.Signals): void;
  /** The last lines the process wrote (for logs only, never shown in the dashboard). */
  output(): string[];
};

export type SpawnOptions = { env: Record<string, string>; cwd?: string; label: string };
export type Spawner = (command: string, args: string[], options: SpawnOptions) => ProcessHandle;

const OUTPUT_LINES = 20;

/** Starts a child process, passing its output through with a label. */
export const spawnProcess: Spawner = (command, args, options) => {
  const child = spawn(command, args, { env: options.env as NodeJS.ProcessEnv, cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
  const lines: string[] = [];
  const pass = (chunk: Buffer, stream: NodeJS.WriteStream) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (!line) continue;
      lines.push(line.slice(0, 500));
      if (lines.length > OUTPUT_LINES) lines.shift();
      stream.write(`[${options.label}] ${line}\n`);
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => pass(chunk, process.stdout));
  child.stderr?.on("data", (chunk: Buffer) => pass(chunk, process.stderr));
  const exited = new Promise<ExitResult>((resolve) => {
    child.once("error", () => resolve({ code: 127, signal: null }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    exited,
    kill: (signal) => {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    },
    output: () => [...lines],
  };
};

/** Litestream failed; the message is fixed text, safe to show. */
export class LitestreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LitestreamError";
  }
}

export const RESTORE_TIMEOUT_MS = 10 * 60_000;

function quote(value: string): string {
  // JSON strings are valid YAML double-quoted scalars; every value is validated ASCII.
  return JSON.stringify(value);
}

/** Litestream's own state directory for a database: ".<file>-litestream" next to it. */
export function litestreamMetaPath(databasePath: string): string {
  const slash = databasePath.lastIndexOf("/");
  return `${databasePath.slice(0, slash + 1)}.${databasePath.slice(slash + 1)}-litestream`;
}

/** The SQLite file and the files that belong to it. */
export function databaseFiles(path: string): string[] {
  return [path, `${path}-wal`, `${path}-shm`, `${path}-journal`, `${path}-txid`];
}

export function removeDatabaseFiles(path: string): void {
  for (const file of databaseFiles(path)) rmSync(file, { force: true });
}

export class Litestream {
  readonly socketPath: string;

  constructor(
    private readonly config: HaConfig,
    private readonly spawner: Spawner = spawnProcess
  ) {
    this.socketPath = join(config.haDir, "litestream.sock");
  }

  /** Where replica `replicaId` lives inside the bucket. */
  replicaPath(replicaId: string): string {
    return `${this.config.storage.path}/replicas/${replicaId}`;
  }

  /** The YAML configuration for `databasePath` and replica `replicaId`. */
  buildConfig(replicaId: string, withSocket: boolean): string {
    const storage = this.config.storage;
    const lines = ["# Written by the high availability supervisor on every start. Do not edit."];
    if (withSocket) {
      lines.push("socket:", "  enabled: true", `  path: ${quote(this.socketPath)}`, "  permissions: 384");
    }
    lines.push(
      "logging:",
      "  level: info",
      "  type: text",
      "dbs:",
      `  - path: ${quote(this.config.databasePath)}`,
      "    replica:",
      "      type: s3",
      `      bucket: ${quote(storage.bucket)}`,
      `      path: ${quote(this.replicaPath(replicaId))}`,
      `      region: ${quote(storage.region)}`
    );
    if (storage.endpoint) lines.push(`      endpoint: ${quote(storage.endpoint)}`);
    lines.push(`      force-path-style: ${storage.forcePathStyle ? "true" : "false"}`, `      sync-interval: ${this.config.syncIntervalSeconds}s`);
    return `${lines.join("\n")}\n`;
  }

  private writeConfig(name: string, replicaId: string, withSocket: boolean): string {
    mkdirSync(this.config.haDir, { recursive: true, mode: 0o700 });
    const path = join(this.config.haDir, `${name}.yml`);
    writeFileSync(`${path}.tmp`, this.buildConfig(replicaId, withSocket), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    return path;
  }

  /** Litestream's environment: the storage keys and nothing else of ours. */
  private env(): Record<string, string> {
    const env: Record<string, string> = {
      AWS_ACCESS_KEY_ID: this.config.storage.accessKeyId,
      AWS_SECRET_ACCESS_KEY: this.config.storage.secretAccessKey,
    };
    for (const name of ["PATH", "HOME", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) {
      const value = process.env[name];
      if (value) env[name] = value;
    }
    return env;
  }

  /**
   * Restores the newest state of `replicaId` into `outputPath` (replacing
   * nothing: the path must not exist). Resolves to false when the replica
   * holds nothing yet; throws LitestreamError when the restore fails.
   */
  async restore(replicaId: string, outputPath: string, timeoutMs = RESTORE_TIMEOUT_MS): Promise<boolean> {
    removeDatabaseFiles(outputPath);
    const configPath = this.writeConfig("restore", replicaId, false);
    const child = this.spawner(
      this.config.litestreamBin,
      [
        "restore",
        "-config",
        configPath,
        "-no-expand-env",
        "-if-replica-exists",
        "-integrity-check",
        "quick",
        "-o",
        outputPath,
        this.config.databasePath,
      ],
      { env: this.env(), label: "litestream restore" }
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      child.exited,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (result === "timeout") {
      child.kill("SIGKILL");
      await child.exited;
      removeDatabaseFiles(outputPath);
      throw new LitestreamError("the restore did not finish in time");
    }
    if (result.code !== 0) {
      removeDatabaseFiles(outputPath);
      throw new LitestreamError(
        result.code === 127 ? "litestream could not be started" : `the restore failed (litestream exited with ${result.code ?? result.signal})`
      );
    }
    return existsSync(outputPath);
  }

  /** Starts streaming the database to `replicaId`; the control socket answers once it runs. */
  startReplicate(replicaId: string): ProcessHandle {
    rmSync(this.socketPath, { force: true });
    const configPath = this.writeConfig("replicate", replicaId, true);
    return this.spawner(this.config.litestreamBin, ["replicate", "-config", configPath, "-no-expand-env"], {
      env: this.env(),
      label: "litestream",
    });
  }

  /** The warm copy of replica `replicaId` on a standby. */
  standbyCopyPath(replicaId: string): string {
    return join(this.config.haDir, `standby-${replicaId}.db`);
  }

  /** The follow restore has written the copy (it writes the -txid file right after the first restore). */
  standbyCopyReady(replicaId: string): boolean {
    const path = this.standbyCopyPath(replicaId);
    return existsSync(path) && existsSync(`${path}-txid`);
  }

  /** Removes warm copies of other replicas: following a new replica always starts from a fresh copy. */
  removeOtherStandbyCopies(keepReplicaId: string | null): void {
    if (!existsSync(this.config.haDir)) return;
    const keep = keepReplicaId ? `standby-${keepReplicaId}.db` : null;
    for (const name of readdirSync(this.config.haDir)) {
      const match = /^(standby-e\d{1,12}-[0-9a-f]{8}\.db)(-wal|-shm|-journal|-txid|-txid\.tmp|\.tmp)?$/.exec(name);
      if (match && match[1] !== keep) rmSync(join(this.config.haDir, name), { force: true });
    }
  }

  /** Keeps a read-only copy of `replicaId` current (litestream restore -f). */
  startFollow(replicaId: string): ProcessHandle {
    const output = this.standbyCopyPath(replicaId);
    this.removeOtherStandbyCopies(replicaId);
    // A copy without its -txid file cannot be resumed.
    if (existsSync(output) && !existsSync(`${output}-txid`)) removeDatabaseFiles(output);
    const configPath = this.writeConfig("follow", replicaId, false);
    return this.spawner(
      this.config.litestreamBin,
      [
        "restore",
        "-config",
        configPath,
        "-no-expand-env",
        "-f",
        "-follow-interval",
        `${this.config.followIntervalSeconds}s`,
        "-o",
        output,
        this.config.databasePath,
      ],
      { env: this.env(), label: "litestream follow" }
    );
  }

  /** When the running `replicate` last confirmed the replica up to date; null before the first sync. */
  async lastSyncAt(timeoutMs = 2_000): Promise<Date | null> {
    const body = await getOverSocket(this.socketPath, "/list", timeoutMs);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new LitestreamError("litestream answered its control socket unexpectedly");
    }
    const databases = (parsed as { databases?: unknown })?.databases;
    if (!Array.isArray(databases)) throw new LitestreamError("litestream answered its control socket unexpectedly");
    const entry = databases.find((item) => (item as { path?: unknown })?.path === this.config.databasePath) as
      | { last_sync_at?: unknown }
      | undefined;
    if (!entry) throw new LitestreamError("litestream does not replicate the database yet");
    if (typeof entry.last_sync_at !== "string") return null;
    const at = new Date(entry.last_sync_at);
    return Number.isNaN(at.getTime()) ? null : at;
  }
}

/** GET over a Unix socket, at most 64 KiB of answer. */
export function getOverSocket(socketPath: string, path: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path, method: "GET", timeout: timeoutMs }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) {
          request.destroy();
          reject(new LitestreamError("litestream answered its control socket unexpectedly"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new LitestreamError("litestream's control socket refused the request"));
          return;
        }
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      response.on("error", () => reject(new LitestreamError("litestream's control socket closed the connection")));
    });
    request.on("timeout", () => {
      request.destroy();
      reject(new LitestreamError("litestream's control socket did not answer in time"));
    });
    request.on("error", () => reject(new LitestreamError("litestream's control socket cannot be reached")));
    request.end();
  });
}
