// SPDX-License-Identifier: Elastic-2.0
/**
 * Entry point of the high availability supervisor, bundled at image build
 * time (docker/web/Dockerfile) to /app/ha/supervisor.js and started by
 * docker/web/entrypoint.sh when HA_ENABLED is set.
 *
 * A configuration error stops the container (exit 78): a node meant to be in
 * a cluster must never run as a dashboard of its own.
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HA_ROLE_ENV, HA_STATUS_FILE_ENV, HaConfigError, parseHaConfig, type HaConfig } from "./config";
import { RedisLeaseStore } from "./lease-store";
import { Litestream, type ExitResult, type ProcessHandle } from "./litestream";
import { localDatabase } from "./local-db";
import { RedisClient } from "./redis-client";
import { S3ReplicaStore } from "./replica-store";
import { writeStatusFile } from "./status";
import { Supervisor, type AppLauncher } from "./supervisor";

/** The Next.js standalone server, as the default entrypoint starts it. */
function appLauncher(config: HaConfig, statusPath: string): AppLauncher {
  return {
    start(role, databasePath) {
      const path = databasePath ?? join(config.haDir, "no-copy.db");
      const child = spawn("bun", ["server.js"], {
        stdio: "inherit",
        env: {
          ...process.env,
          HOSTNAME: "0.0.0.0",
          [HA_ROLE_ENV]: role,
          [HA_STATUS_FILE_ENV]: statusPath,
          DATABASE_PATH: path,
          DATABASE_URL: `file:${path}`,
        },
      });
      const exited = new Promise<ExitResult>((resolve) => {
        child.once("error", () => resolve({ code: 127, signal: null }));
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      const handle: ProcessHandle = {
        exited,
        kill: (signal) => {
          try {
            child.kill(signal);
          } catch {
            // Already gone.
          }
        },
        output: () => [],
      };
      return handle;
    },
  };
}

/** HA_ENABLED was set but parses as off: run the dashboard as the default entrypoint does. */
function runPlain(): void {
  const child = spawn("bun", ["server.js"], { stdio: "inherit", env: { ...process.env, HOSTNAME: "0.0.0.0" } });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal));
  child.once("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

function main(): void {
  let config: HaConfig | null;
  try {
    config = parseHaConfig(process.env);
  } catch (error) {
    console.error(`[ha] ${error instanceof HaConfigError ? error.message : "the high availability configuration cannot be read"}`);
    process.exit(78);
  }
  if (!config) {
    runPlain();
    return;
  }

  mkdirSync(config.haDir, { recursive: true, mode: 0o700 });
  rmSync(join(config.haDir, "restore.db"), { force: true });
  const statusPath = join(config.haDir, "status.json");
  const supervisor = new Supervisor({
    config,
    store: new RedisLeaseStore(new RedisClient(config.redis), config.redis.keyPrefix),
    replicas: new S3ReplicaStore(config.storage),
    litestream: new Litestream(config),
    app: appLauncher(config, statusPath),
    local: localDatabase,
    writeStatus: (status) => writeStatusFile(statusPath, status),
    // Let the last log lines and the status file reach the disk.
    exit: (code) => setTimeout(() => process.exit(code), 50),
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => void supervisor.shutdown());
  }
  supervisor.start();
}

main();
