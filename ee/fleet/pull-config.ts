// SPDX-License-Identifier: Elastic-2.0
/**
 * Pull replicas, the replica's side of the protocol pieces that do not need
 * the database: its configuration from the environment, the form of a pull
 * credential, and the token its sync fingerprints are keyed with. The master
 * side and the polling agent are in ee/fleet (pull-replicas.ts,
 * pull-server.ts, pull-agent.ts).
 *
 * A pull replica is a slave (INSTANCE_MODE=slave) with INSTANCE_SYNC_MODE=pull:
 * instead of waiting for the master to push, it polls INSTANCE_MASTER_URL
 * with the credential the master issued for it (INSTANCE_PULL_TOKEN). It then
 * refuses pushes (GET and POST /api/instances/sync).
 */
import { createHash, hkdfSync } from "node:crypto";
import { getSlaveMasterToken, isHttpSyncAllowed } from "@/src/lib/instance-sync";
import { instanceBaseUrlValidationError } from "@/src/lib/models/instances";

export const ENV_INSTANCE_SYNC_MODE = "INSTANCE_SYNC_MODE";
export const ENV_INSTANCE_MASTER_URL = "INSTANCE_MASTER_URL";
export const ENV_INSTANCE_PULL_TOKEN = "INSTANCE_PULL_TOKEN";
export const ENV_INSTANCE_PULL_INTERVAL = "INSTANCE_PULL_INTERVAL";

export const DEFAULT_PULL_INTERVAL_SECONDS = 30;
export const MIN_PULL_INTERVAL_SECONDS = 10;
export const MAX_PULL_INTERVAL_SECONDS = 3600;

/** The path pull replicas poll on the master. */
export const PULL_ENDPOINT_PATH = "/api/instances/pull";
/** The version of the poll request and reply (see ee/fleet/pull-server.ts). */
export const PULL_PROTOCOL_VERSION = 1;
/** Largest poll request the master reads: a key, its proofs and a status report. */
export const MAX_PULL_REQUEST_BYTES = 64 * 1024;

/** A pull credential: this prefix and 32 random bytes, base64url. */
export const PULL_CREDENTIAL_PREFIX = "pull_";
const PULL_CREDENTIAL_PATTERN = /^pull_[A-Za-z0-9_-]{43}$/;

// Separates the fingerprint token from anything else derived from a credential.
const FINGERPRINT_TOKEN_INFO = "ingressi:fleet-pull:fingerprint-token:v1";

export function isPullCredential(value: unknown): value is string {
  return typeof value === "string" && PULL_CREDENTIAL_PATTERN.test(value);
}

/** What the master stores of a credential: its SHA-256, hex. */
export function pullCredentialHash(credential: string): string {
  return createHash("sha256").update(credential, "utf8").digest("hex");
}

/**
 * The token a pull replica's sync fingerprints and local digest are keyed
 * with (see instance-sync-fingerprint.ts), in the place of a pushed slave's
 * sync token. Derived from the credential, so the replica computes it and the
 * master keeps it (encrypted) without keeping the credential, which it cannot
 * be turned back into.
 */
export function pullFingerprintToken(credential: string): string {
  return Buffer.from(hkdfSync("sha256", credential, Buffer.alloc(0), FINGERPRINT_TOKEN_INFO, 32)).toString("base64url");
}

export type PullReplicaConfig =
  | { mode: "push" }
  | { mode: "pull"; ok: true; masterUrl: string; credential: string; intervalSeconds: number }
  | { mode: "pull"; ok: false; error: string };

function readInterval(value: string | undefined): number {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d{1,6}$/.test(trimmed)) return DEFAULT_PULL_INTERVAL_SECONDS;
  return Math.min(Math.max(Number(trimmed), MIN_PULL_INTERVAL_SECONDS), MAX_PULL_INTERVAL_SECONDS);
}

/**
 * This instance's pull configuration, read from the environment on every
 * call. "push" unless INSTANCE_SYNC_MODE is "pull". The master URL must be a
 * plain https origin (optionally with a path), or http with
 * INSTANCE_SYNC_ALLOW_HTTP; the credential must have the form the master
 * issues. Error messages are fixed and never include the values.
 */
export function getPullReplicaConfig(): PullReplicaConfig {
  if (process.env[ENV_INSTANCE_SYNC_MODE]?.trim().toLowerCase() !== "pull") return { mode: "push" };

  const rawUrl = process.env[ENV_INSTANCE_MASTER_URL]?.trim() ?? "";
  if (!rawUrl) return { mode: "pull", ok: false, error: `${ENV_INSTANCE_MASTER_URL} is not set` };
  const urlError = instanceBaseUrlValidationError(rawUrl);
  if (urlError) return { mode: "pull", ok: false, error: `${ENV_INSTANCE_MASTER_URL} is invalid: ${urlError}` };
  const url = new URL(rawUrl);
  if (url.protocol === "http:" && !isHttpSyncAllowed()) {
    return {
      mode: "pull",
      ok: false,
      error: `${ENV_INSTANCE_MASTER_URL} must use https (or set INSTANCE_SYNC_ALLOW_HTTP=true to allow insecure sync)`,
    };
  }

  const credential = process.env[ENV_INSTANCE_PULL_TOKEN]?.trim() ?? "";
  if (!credential) return { mode: "pull", ok: false, error: `${ENV_INSTANCE_PULL_TOKEN} is not set` };
  if (!isPullCredential(credential)) {
    return {
      mode: "pull",
      ok: false,
      error: `${ENV_INSTANCE_PULL_TOKEN} is not a pull credential (it starts with "${PULL_CREDENTIAL_PREFIX}"; the master shows it once when it adds the replica)`,
    };
  }

  return {
    mode: "pull",
    ok: true,
    masterUrl: `${url.origin}${url.pathname.replace(/\/+$/, "")}`,
    credential,
    intervalSeconds: readInterval(process.env[ENV_INSTANCE_PULL_INTERVAL]),
  };
}

export function isPullReplicaMode(): boolean {
  return getPullReplicaConfig().mode === "pull";
}

/**
 * The token this slave's sync fingerprints are keyed with: derived from the
 * pull credential on a pull replica, the master's sync token otherwise.
 * Null when there is none (nothing is then recorded or reported).
 */
export async function getSlaveFingerprintToken(): Promise<string | null> {
  const pull = getPullReplicaConfig();
  if (pull.mode === "pull") return pull.ok ? pullFingerprintToken(pull.credential) : null;
  return getSlaveMasterToken();
}
