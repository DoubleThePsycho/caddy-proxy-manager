// SPDX-License-Identifier: Elastic-2.0
/**
 * The pull replica's agent: on a slave with INSTANCE_SYNC_MODE=pull (see
 * ee/fleet/pull-config.ts), poll the master every INSTANCE_PULL_INTERVAL
 * seconds (default 30, with ±20% jitter) instead of waiting for pushes.
 *
 * Each poll POSTs to INSTANCE_MASTER_URL + /api/instances/pull, with the pull
 * credential, this instance's sync key (with a fresh single-use nonce and the
 * proof that it holds the key, for the challenge the master sent last), the
 * fingerprint of what it runs and its status (see pull-server.ts). The master
 * answers "no change", or with the configuration sealed to this key and this
 * poll's nonce, which is applied exactly like a push (validation, sealed
 * secrets opened, stored, Caddy applied, recorded for drift detection). The
 * next poll follows at once and reports the result.
 *
 * Requests follow no redirects, are bounded in time (INSTANCE_SYNC_TIMEOUT_MS)
 * and the reply in size (INSTANCE_SYNC_MAX_BYTES), and failures back off
 * exponentially (to 15 minutes). Messages are fixed: the credential, the
 * master's reply and the configuration are never logged.
 *
 * Runs whatever the license state: the replica holds no license of its own.
 */
import { config as appConfig, DISALLOWED_SESSION_SECRETS } from "@/src/lib/config";
import { getInstanceMode, getSyncRequestTimeoutMs, setSlaveLastSync, type SyncPayload } from "@/src/lib/instance-sync";
import { SYNC_SEALED_STALE_ERROR } from "@/src/lib/instance-sync-error";
import {
  PULL_ENDPOINT_PATH,
  PULL_PROTOCOL_VERSION,
  getPullReplicaConfig,
  pullCredentialHash,
  type PullReplicaConfig,
} from "@/ee/fleet/pull-config";
import { buildReplicaSyncStatus } from "@/src/lib/instance-sync-status";
import { syncPayloadValidationError } from "@/src/lib/instance-sync-validation";
import { MAX_SYNC_BODY_BYTES, applyReceivedSyncPayload } from "@/src/lib/instance-sync-apply";
import { shareSyncNonce } from "@/src/lib/sync-nonces";
import {
  SyncSealError,
  createSyncKeyResponse,
  isSyncKeyChallengeValue,
  type SyncPublicKeyResponse,
} from "@/src/lib/sync-crypto";
import { onShutdown } from "@/src/lib/shutdown";

export type ReadyPullConfig = Extract<PullReplicaConfig, { ok: true }>;

/** How one poll went. `retry`: poll again at once (a challenge to answer, or a key rotation to prove). */
export type PullOutcome =
  | { kind: "unchanged" }
  | { kind: "applied" }
  | { kind: "retry"; error: string }
  | { kind: "failed"; error: string; retryAfterMs?: number };

/** Largest reply read: a payload and the reply around it. */
const MAX_REPLY_BYTES = MAX_SYNC_BODY_BYTES + 64 * 1024;
/** Polls that follow at once in one round: answering a challenge, reporting what was applied. */
const MAX_FOLLOW_UPS = 3;
const FIRST_POLL_DELAY_MS = 5_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const JITTER = 0.2;

export type PullAgentStatus = {
  /** Set when INSTANCE_SYNC_MODE=pull. */
  masterUrl: string | null;
  intervalSeconds: number | null;
  /** Why the configuration cannot be used (fixed message), or null. */
  configError: string | null;
  /** The master's last answer to a poll (unchanged or a configuration). */
  lastCheckInAt: string | null;
  lastAppliedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** Failed rounds in a row. */
  failures: number;
};

type AgentState = {
  /** The master's last challenge, per credential (one in production; tests run several replicas in one process). */
  challenges: Map<string, string>;
  timer: ReturnType<typeof setTimeout> | null;
  started: boolean;
  running: boolean;
  failures: number;
  lastCheckInAt: string | null;
  lastAppliedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  lastLogged: string | null;
};

const store = globalThis as typeof globalThis & { __ingressiPullAgent?: AgentState };
const state = (store.__ingressiPullAgent ??= {
  challenges: new Map<string, string>(),
  timer: null,
  started: false,
  running: false,
  failures: 0,
  lastCheckInAt: null,
  lastAppliedAt: null,
  lastError: null,
  lastErrorAt: null,
  lastLogged: null,
});

/** Test helper: forget the challenge and the history, as a restart does. */
export function resetPullAgentForTests(): void {
  stopPullAgent();
  state.challenges.clear();
  Object.assign(state, {
    started: false,
    running: false,
    failures: 0,
    lastCheckInAt: null,
    lastAppliedAt: null,
    lastError: null,
    lastErrorAt: null,
    lastLogged: null,
  });
}

function isTimeoutError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "TimeoutError";
}

/** The reply's JSON, or null when it is not JSON or larger than `maxBytes` (the rest is not read). */
async function readReplyJson(response: Response, maxBytes: number): Promise<Record<string, unknown> | null> {
  try {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch (error) {
    if (isTimeoutError(error)) throw error;
    return null;
  }
}

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) * 1000 : undefined;
}

/**
 * Apply a configuration the master sent for this poll. It must be sealed to
 * this instance's key with this poll's nonce: an unsealed payload, or one
 * sealed for another request (a replayed reply), is refused before anything
 * is written. Opening the sealed secrets uses the nonce up.
 */
async function applyPulled(payload: unknown, key: SyncPublicKeyResponse): Promise<PullOutcome> {
  if (syncPayloadValidationError(payload)) {
    await setSlaveLastSync({ ok: false, error: "Failed to apply synchronized configuration" });
    return { kind: "failed", error: "The master sent a configuration that does not pass validation" };
  }
  const sealed = payload as SyncPayload;
  if (sealed.secrets_sealed_key_id !== key.keyId || sealed.secrets_sealed_nonce !== key.nonce) {
    await setSlaveLastSync({ ok: false, error: SYNC_SEALED_STALE_ERROR });
    return { kind: "failed", error: "The master's reply was not sealed for this poll; it was not applied" };
  }
  const result = await applyReceivedSyncPayload(sealed);
  if (!result.ok) return { kind: "failed", error: `The configuration from the master could not be applied: ${result.error}` };
  state.lastAppliedAt = new Date().toISOString();
  return { kind: "applied" };
}

/** This instance's key, with the proof for the master's last challenge when there is one. */
async function keyForPoll(challenge: string | null): Promise<SyncPublicKeyResponse> {
  let key: SyncPublicKeyResponse;
  try {
    key = createSyncKeyResponse(challenge, { proveCurrentKey: true });
  } catch (error) {
    if (!(error instanceof SyncSealError)) throw error;
    key = createSyncKeyResponse(null);
  }
  // The reply is applied wherever this instance applies it (src/lib/sync-nonces.ts).
  await shareSyncNonce(key.nonce);
  return key;
}

/** One poll: send the key and the status, apply what comes back. */
export async function pullOnce(config: ReadyPullConfig): Promise<PullOutcome> {
  const slot = pullCredentialHash(config.credential);
  const challenge = state.challenges.get(slot) ?? null;
  state.challenges.delete(slot);
  const key = await keyForPoll(challenge);
  const { syncStatus } = await buildReplicaSyncStatus();
  const body = JSON.stringify({
    version: PULL_PROTOCOL_VERSION,
    key,
    challenge: key.rotationProofs ? challenge : null,
    pollIntervalSeconds: config.intervalSeconds,
    status: syncStatus,
    // What GET /api/health answers: this dashboard process is up.
    health: { status: "ok" },
  });

  let response: Response;
  let reply: Record<string, unknown> | null;
  try {
    response = await fetch(`${config.masterUrl}${PULL_ENDPOINT_PATH}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.credential}`,
      },
      body,
      // The reply carries configuration; it must come from the configured URL.
      redirect: "manual",
      signal: AbortSignal.timeout(getSyncRequestTimeoutMs()),
    });
    reply = await readReplyJson(response, MAX_REPLY_BYTES);
  } catch (error) {
    return { kind: "failed", error: isTimeoutError(error) ? "The pull request timed out" : "The pull request failed (network)" };
  }
  const nextChallenge = reply && isSyncKeyChallengeValue(reply.challenge) ? reply.challenge : null;
  if (nextChallenge) state.challenges.set(slot, nextChallenge);

  if (response.status === 200 && reply?.version === PULL_PROTOCOL_VERSION) {
    if (reply.changed === false) {
      state.lastCheckInAt = new Date().toISOString();
      return { kind: "unchanged" };
    }
    if (reply.changed === true) {
      state.lastCheckInAt = new Date().toISOString();
      return applyPulled(reply.payload, key);
    }
  }
  if (response.status >= 300 && response.status < 400) {
    return { kind: "failed", error: `The master answered with a redirect (HTTP ${response.status}), which is not followed; check INSTANCE_MASTER_URL` };
  }
  if (response.status === 401 && nextChallenge) {
    return { kind: "retry", error: "The master asked for the proof of this instance's sync key" };
  }
  if (response.status === 401) return { kind: "failed", error: "The master refused the pull credential (HTTP 401): it is wrong, revoked or rotated" };
  if (response.status === 403) {
    return { kind: "failed", error: "The master refused this replica (HTTP 403): it is disabled there, or the URL is not a master" };
  }
  if (response.status === 409 && nextChallenge) {
    return {
      kind: "retry",
      error:
        "The master refused this instance's sync key (HTTP 409): it pinned another key. If SESSION_SECRET was rotated, set " +
        "SESSION_SECRET_PREVIOUS to the old value; otherwise pin this instance's key on the master or reset its pin",
    };
  }
  if (response.status === 429) return { kind: "failed", error: "The master is rate limiting this replica (HTTP 429)", retryAfterMs: retryAfterMs(response) };
  if (response.status === 200) return { kind: "failed", error: "The master sent an invalid reply" };
  return { kind: "failed", error: `The pull request failed with HTTP ${response.status}` };
}

function withJitter(ms: number): number {
  return Math.round(ms * (1 - JITTER + Math.random() * 2 * JITTER));
}

function schedule(delayMs: number): void {
  if (!state.started) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => void runPullRound(), delayMs);
  state.timer.unref?.();
}

function recordError(error: string | null): void {
  if (error === null) {
    if (state.lastError !== null) console.log("Pull replica: polling the master works again");
    state.lastError = null;
    state.lastLogged = null;
    return;
  }
  state.lastError = error;
  state.lastErrorAt = new Date().toISOString();
  if (state.lastLogged !== error) {
    state.lastLogged = error;
    console.warn(`Pull replica: ${error}`);
  }
}

/**
 * One round: a poll and the polls that follow at once (a challenge to
 * answer, a result to report). Returns the delay before the next round:
 * the interval with jitter, or a growing back-off after failures.
 */
export async function runPullRound(): Promise<number> {
  const config = getPullReplicaConfig();
  const intervalMs = (config.mode === "pull" && config.ok ? config.intervalSeconds : 60) * 1000;
  if (state.running) return intervalMs;
  state.running = true;
  let delay = withJitter(intervalMs);
  try {
    if (config.mode !== "pull" || !config.ok) {
      recordError(config.mode === "pull" ? config.error : "INSTANCE_SYNC_MODE is not pull");
      return delay;
    }
    if ((await getInstanceMode()) !== "slave") {
      recordError("INSTANCE_SYNC_MODE=pull needs the instance in slave mode (INSTANCE_MODE=slave)");
      return delay;
    }
    // Anyone can prove a key derived from a public placeholder, so the master
    // never accepts one (development setups fall back to such a secret).
    if (DISALLOWED_SESSION_SECRETS.has(appConfig.sessionSecret)) {
      recordError("SESSION_SECRET is a public placeholder, so the master cannot trust this replica's sync key; set a SESSION_SECRET of its own");
      return delay;
    }
    let outcome = await pullOnce(config);
    for (let follow = 0; follow < MAX_FOLLOW_UPS && (outcome.kind === "retry" || outcome.kind === "applied"); follow++) {
      outcome = await pullOnce(config);
    }
    // A configuration applied in the last follow-up is reported next round.
    if (outcome.kind === "unchanged" || outcome.kind === "applied") {
      state.failures = 0;
      recordError(null);
    } else {
      state.failures++;
      recordError(outcome.error);
      const backoff = Math.min(intervalMs * 2 ** Math.min(state.failures - 1, 8), MAX_BACKOFF_MS);
      delay = Math.max(withJitter(Math.max(backoff, intervalMs)), outcome.kind === "failed" ? outcome.retryAfterMs ?? 0 : 0);
    }
    return delay;
  } catch (error) {
    state.failures++;
    recordError("A poll failed unexpectedly");
    console.warn("Pull replica: poll error:", error instanceof Error ? error.name : typeof error);
    delay = withJitter(Math.max(Math.min(intervalMs * 2 ** Math.min(state.failures - 1, 8), MAX_BACKOFF_MS), intervalMs));
    return delay;
  } finally {
    state.running = false;
    schedule(delay);
  }
}

/**
 * Start polling when this instance is a pull replica (INSTANCE_SYNC_MODE=pull).
 * Returns whether it was started; a configuration error is logged once.
 */
export function startPullAgent(): boolean {
  const config = getPullReplicaConfig();
  if (config.mode !== "pull") return false;
  if (!config.ok) {
    console.error(`Pull replica: ${config.error}; not polling the master`);
    return false;
  }
  if (state.started) return true;
  state.started = true;
  schedule(FIRST_POLL_DELAY_MS + Math.round(Math.random() * Math.min(config.intervalSeconds, 30) * 1000));
  onShutdown("stopping the pull replica agent", stopPullAgent);
  return true;
}

export function stopPullAgent(): void {
  state.started = false;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
}

/** What the replica's settings page shows. Holds no secret. */
export function getPullAgentStatus(): PullAgentStatus {
  const config = getPullReplicaConfig();
  return {
    masterUrl: config.mode === "pull" && config.ok ? config.masterUrl : null,
    intervalSeconds: config.mode === "pull" && config.ok ? config.intervalSeconds : null,
    configError: config.mode === "pull" && !config.ok ? config.error : null,
    lastCheckInAt: state.lastCheckInAt,
    lastAppliedAt: state.lastAppliedAt,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt,
    failures: state.failures,
  };
}
