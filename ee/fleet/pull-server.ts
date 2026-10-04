// SPDX-License-Identifier: Elastic-2.0
/**
 * The master's side of the pull protocol: POST /api/instances/pull, which a
 * pull replica (pull-agent.ts) sends every poll interval.
 *
 * The request carries the replica's credential (Bearer), its sync key
 * response (the same body a pushed slave serves on GET /api/instances/sync:
 * public key, a fresh single-use nonce it issued, proofs), the challenge the
 * master sent with its previous reply, the poll interval and a status report
 * (the body of GET /api/instances/sync?status=1, and its health). The master:
 *
 * 1. authenticates the credential (only its hash is stored) and refuses a
 *    disabled replica;
 * 2. checks the proof that the replica holds the private key of the key it
 *    presents, for a single-use challenge the master issued (otherwise 401
 *    with a fresh challenge), then checks the key against the replica's pin
 *    exactly as a push does: pinned on first contact, re-pinned only with a
 *    rotation proof, refused otherwise (409);
 * 3. records the check-in and the report;
 * 4. works out what the replica should run (resolvePullDesired), and answers
 *    "no change" when the replica reports that fingerprint, or the payload
 *    with every secret sealed to the replica's key and nonce, exactly as a
 *    push would carry it. When the replica reports it runs what it should
 *    (and Caddy took it), that is recorded as a push: drift detection and
 *    rollouts read it from there.
 *
 * Runtime path: never checks the license.
 */
import { createPrivateKey } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { fleetInstances, fleetPullReplicas, instances } from "@/src/lib/db/schema";
import { UNKNOWN_CLIENT_IP, getClientIp, ipRateLimitBucket } from "@/src/lib/client-ip";
import { createRateLimiter, type RateLimiter } from "@/src/lib/rate-limit";
import { decryptSecret, encryptSecret } from "@/src/lib/secret";
import { defineRuntimeEntries } from "@/src/lib/shared-runtime-state";
import {
  buildSyncPayload,
  buildSyncPayloadFromContent,
  checkPullReplicaSyncKey,
  getInstanceMode,
  sealSyncPayloadForReplica,
  syncPayloadFingerprint,
  type SyncPayload,
} from "@/src/lib/instance-sync";
import { SYNC_PULL_UNAVAILABLE_ERROR, SYNC_REPLICA_CADDY_FAILED_ERROR } from "@/src/lib/instance-sync-error";
import { parseReplicaSyncStatus, type ReplicaSyncStatus } from "@/src/lib/instance-sync-fingerprint";
import {
  MAX_PULL_INTERVAL_SECONDS,
  MAX_PULL_REQUEST_BYTES,
  MIN_PULL_INTERVAL_SECONDS,
  PULL_PROTOCOL_VERSION,
} from "@/ee/fleet/pull-config";
import { recordInstanceSyncResult } from "@/src/lib/models/instances";
import {
  createSyncKeyChallenge,
  isSyncKeyChallengeValue,
  parseSyncKeyRotationProofs,
  parseSyncPublicKeyResponse,
  verifySyncKeyPossession,
  type SyncKeyChallenge,
  type SyncKeyRotationProof,
  type SyncSealTarget,
} from "@/src/lib/sync-crypto";
import { recordFleetPush } from "./state";
import { getRevisionContent } from "./revisions";
import { kickRollouts } from "./rollouts";
import { authenticatePullCredential, resolvePullDesired, type PullReplicaRow } from "./pull-replicas";

export const PULL_PROOF_REQUIRED_ERROR = "Prove the sync key for the challenge in this reply, then poll again";
export const PULL_DISABLED_ERROR = "This pull replica is disabled on the master";
export const PULL_NOT_MASTER_ERROR = "This instance is not a master";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

// Pre-authentication limit per client address; every request counts. Pull
// replicas behind one NAT share an address, so it is generous: each polls a
// few times a minute at most. A replica has its own, tighter limit once its
// credential is known.
const addressLimiter = createRateLimiter({
  name: "pull-address",
  maxAttempts: positiveIntegerEnv("INSTANCE_PULL_RATE_MAX", 300),
  windowMs: positiveIntegerEnv("INSTANCE_PULL_RATE_WINDOW_MS", 60_000),
  blockMs: "window",
});
const replicaLimiter = createRateLimiter({
  name: "pull-replica",
  maxAttempts: positiveIntegerEnv("INSTANCE_PULL_REPLICA_RATE_MAX", 30),
  windowMs: 60_000,
  blockMs: "window",
});

// ── Challenges ──────────────────────────────────────────────────────────

/** Longer than the longest poll interval, so a replica's next poll still finds its challenge. */
const CHALLENGE_TTL_MS = (MAX_PULL_INTERVAL_SECONDS + 15 * 60) * 1000;

/** An issued challenge: its private key (PKCS#8, encryptSecret). */
type StoredChallenge = { key: string };

/**
 * Issued challenges by "<replica id>:<challenge>", until used or expired.
 * The next poll may reach another master replica (several replicas on one
 * PostgreSQL database): there they live in the shared runtime state
 * (src/lib/shared-runtime-state.ts); in memory on SQLite, where a restart
 * costs the replica one more round trip.
 */
const challenges = defineRuntimeEntries<StoredChallenge>("pull-challenge", {
  maxEntries: 4_000,
  isValue: (value): value is StoredChallenge =>
    typeof value === "object" && value !== null && typeof (value as { key?: unknown }).key === "string",
});

/** A fresh single-use challenge for replica `instanceId`'s next poll. */
async function issueChallenge(instanceId: number): Promise<string> {
  const challenge = createSyncKeyChallenge();
  const der = challenge.privateKey.export({ format: "der", type: "pkcs8" });
  await challenges.put(`${instanceId}:${challenge.value}`, { key: encryptSecret(der.toString("base64")) }, CHALLENGE_TTL_MS);
  return challenge.value;
}

/** Use up the challenge `value` of replica `instanceId`; null when it is unknown or expired. */
async function takeChallenge(instanceId: number, value: string): Promise<SyncKeyChallenge | null> {
  const stored = await challenges.take(`${instanceId}:${value}`);
  if (!stored) return null;
  try {
    const der = Buffer.from(decryptSecret(stored.key, "pull challenge"), "base64");
    return { value, publicKey: Buffer.from(value, "base64url"), privateKey: createPrivateKey({ key: der, format: "der", type: "pkcs8" }) };
  } catch {
    // Not readable (SESSION_SECRET changed): the replica gets a new one.
    return null;
  }
}

/** Test helper: forget every issued challenge, as a restart does on SQLite. */
export async function resetPullChallengesForTests(): Promise<void> {
  await challenges.clear();
}

// ── The request ─────────────────────────────────────────────────────────

type PullRequest = {
  key: SyncSealTarget;
  proofs: SyncKeyRotationProof[];
  challenge: string | null;
  pollIntervalSeconds: number;
  status: ReplicaSyncStatus;
  healthy: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The poll request, or the fixed reason it is malformed. */
function parsePullRequest(body: unknown): PullRequest | string {
  if (!isRecord(body)) return "Request body must be a JSON object";
  if (body.version !== PULL_PROTOCOL_VERSION) return "Unsupported pull protocol version";
  const key = parseSyncPublicKeyResponse(body.key);
  if (!key) return "Invalid sync key";
  const challenge = body.challenge === null || body.challenge === undefined ? null : body.challenge;
  if (challenge !== null && !isSyncKeyChallengeValue(challenge)) return "Invalid challenge";
  const interval = body.pollIntervalSeconds;
  if (typeof interval !== "number" || !Number.isInteger(interval) || interval < MIN_PULL_INTERVAL_SECONDS || interval > MAX_PULL_INTERVAL_SECONDS) {
    return `pollIntervalSeconds must be a whole number from ${MIN_PULL_INTERVAL_SECONDS} to ${MAX_PULL_INTERVAL_SECONDS}`;
  }
  const status = parseReplicaSyncStatus({ syncStatus: body.status });
  if (status.kind !== "ok") return "Invalid status report";
  return {
    key,
    proofs: parseSyncKeyRotationProofs(body.key),
    challenge,
    pollIntervalSeconds: interval,
    status: status.status,
    healthy: isRecord(body.health) && body.health.status === "ok",
  };
}

async function readBody(request: NextRequest): Promise<{ body: unknown } | { error: string; status: number }> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PULL_REQUEST_BYTES) return { error: "Pull request too large", status: 413 };
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { error: "Invalid request body", status: 400 };
  }
  if (Buffer.byteLength(text, "utf8") > MAX_PULL_REQUEST_BYTES) return { error: "Pull request too large", status: 413 };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: "Invalid JSON payload", status: 400 };
  }
}

function reply(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

async function limited(limiter: RateLimiter, key: string): Promise<NextResponse | null> {
  const outcome = await limiter.isRateLimited(key);
  if (outcome.blocked) {
    const retryAfter = outcome.retryAfterMs ? Math.ceil(outcome.retryAfterMs / 1000) : 60;
    return reply(429, { error: "Too many pull requests. Please retry later." }, { "Retry-After": String(retryAfter) });
  }
  await limiter.registerAttempt(key);
  return null;
}

// ── Answering ───────────────────────────────────────────────────────────

type InstanceRow = typeof instances.$inferSelect;
type Answer = { changed: false } | { changed: true; payload: SyncPayload };

/**
 * Payloads built for polls, kept a few seconds so that replicas polling at
 * about the same time share one build (reading the configuration and
 * decrypting its secrets) and its canonical form; each replica's fingerprint
 * is one HMAC over it. A change reaches replicas at most this much later.
 */
const PAYLOAD_TTL_MS = 5_000;
const payloads = new Map<string, { payload: Promise<SyncPayload>; expiresAt: number }>();

function pullPayload(desired: { kind: "live" } | { kind: "revision"; revisionId: number }): Promise<SyncPayload> {
  const key = desired.kind === "live" ? "live" : `revision:${desired.revisionId}`;
  const now = Date.now();
  for (const [cachedKey, entry] of payloads) {
    if (entry.expiresAt <= now) payloads.delete(cachedKey);
  }
  const cached = payloads.get(key);
  if (cached) return cached.payload;
  const payload = (async () => {
    if (desired.kind === "live") return buildSyncPayload();
    const content = await getRevisionContent(desired.revisionId);
    if (!content) throw new Error("revision not kept");
    return buildSyncPayloadFromContent(content);
  })();
  payloads.set(key, { payload, expiresAt: now + PAYLOAD_TTL_MS });
  // A failed build is not kept.
  payload.catch(() => {
    if (payloads.get(key)?.payload === payload) payloads.delete(key);
  });
  return payload;
}

/** Test helper: forget the payloads built for polls. */
export function resetPullPayloadsForTests(): void {
  payloads.clear();
}

/**
 * Record that the replica runs what it should (`fingerprint`, of revision
 * `revisionId`, null for the master's configuration) as a successful push,
 * when that tells the master something new: another configuration, a
 * rollout waiting for it, a re-sync to confirm, or an earlier failure.
 */
async function confirmPull(
  instance: InstanceRow,
  row: PullReplicaRow,
  confirmed: { fingerprint: string; revisionId: number | null; rolloutTarget: { requestedAt: string } | null }
): Promise<void> {
  const [fleet] = await appDb
    .select({ pushedFingerprint: fleetInstances.pushedFingerprint, revisionId: fleetInstances.revisionId, pushedAt: fleetInstances.pushedAt })
    .from(fleetInstances)
    .where(eq(fleetInstances.instanceId, instance.id))
    .limit(1);
  const changed = fleet?.pushedFingerprint !== confirmed.fingerprint || (fleet?.revisionId ?? null) !== confirmed.revisionId;
  const awaited = confirmed.rolloutTarget !== null && (!fleet?.pushedAt || fleet.pushedAt < confirmed.rolloutTarget.requestedAt);
  const unrecorded = instance.lastSyncError !== null || !instance.lastSyncAt;
  const resync = row.resyncRequestedAt !== null;
  if (!changed && !awaited && !unrecorded && !resync) return;

  await recordInstanceSyncResult(instance.id, { ok: true });
  await recordFleetPush(instance.id, { revisionId: confirmed.revisionId, fingerprint: confirmed.fingerprint, legacy: false });
  if (resync) {
    await appDb
      .update(fleetPullReplicas)
      .set({ resyncRequestedAt: null, resyncRevisionId: null, updatedAt: nowIso() })
      .where(eq(fleetPullReplicas.instanceId, instance.id));
  }
  if (confirmed.rolloutTarget) kickRollouts();
}

async function answer(instance: InstanceRow, row: PullReplicaRow, request: PullRequest): Promise<Answer> {
  const desired = await resolvePullDesired(instance.id, row);
  if (desired.kind === "none") return { changed: false };

  let payload: SyncPayload;
  try {
    payload = await pullPayload(desired);
  } catch (error) {
    console.warn(`[fleet] The configuration for pull replica ${instance.id} could not be prepared:`, error instanceof Error ? error.name : typeof error);
    await recordInstanceSyncResult(instance.id, { ok: false, error: SYNC_PULL_UNAVAILABLE_ERROR });
    return { changed: false };
  }

  let token: string;
  try {
    token = decryptSecret(row.fingerprintToken ?? "", `pull replica "${instance.name}" fingerprint token`);
  } catch {
    await recordInstanceSyncResult(instance.id, { ok: false, error: "Stored token could not be decrypted" });
    return { changed: false };
  }
  const fingerprint = syncPayloadFingerprint(payload, token);
  const revisionId = desired.kind === "revision" ? desired.revisionId : null;
  const rolloutTarget = desired.kind === "revision" ? desired.rolloutTarget : null;
  const status = request.status;
  // A rollout overwrites what was changed on the replica, as a push would.
  const force = desired.force || (rolloutTarget !== null && status.localChanges === true);

  if (status.fingerprint === fingerprint && !force) {
    if (status.caddy && !status.caddy.ok) {
      await recordInstanceSyncResult(instance.id, { ok: false, error: SYNC_REPLICA_CADDY_FAILED_ERROR });
    } else {
      await confirmPull(instance, row, { fingerprint, revisionId, rolloutTarget });
    }
    return { changed: false };
  }

  // The replica tried what was sent last and could not apply it.
  if (row.deliveredFingerprint && status.fingerprint !== row.deliveredFingerprint && status.lastSync.error) {
    await recordInstanceSyncResult(instance.id, { ok: false, error: status.lastSync.error });
  }

  // parseSyncPublicKeyResponse refused keys nothing can be sealed to.
  const sealed = sealSyncPayloadForReplica(payload, request.key);
  const now = nowIso();
  await appDb
    .update(fleetPullReplicas)
    .set({ deliveredFingerprint: fingerprint, deliveredRevisionId: revisionId, deliveredAt: now, updatedAt: now })
    .where(eq(fleetPullReplicas.instanceId, instance.id));
  return { changed: true, payload: sealed };
}

/** POST /api/instances/pull. */
export async function handlePullRequest(request: NextRequest): Promise<NextResponse> {
  const address = getClientIp(request.headers);
  const refusedAddress = await limited(addressLimiter, ipRateLimitBucket(address));
  if (refusedAddress) return refusedAddress;

  if ((await getInstanceMode()) !== "master") return reply(403, { error: PULL_NOT_MASTER_ERROR });

  const found = await authenticatePullCredential(request.headers.get("authorization"));
  if (!found) return reply(401, { error: "Unauthorized" });
  const { instance, row } = found;
  const refusedReplica = await limited(replicaLimiter, String(instance.id));
  if (refusedReplica) return refusedReplica;
  if (!instance.enabled) return reply(403, { error: PULL_DISABLED_ERROR });

  const read = await readBody(request);
  if ("error" in read) return reply(read.status, { error: read.error });
  const parsed = parsePullRequest(read.body);
  if (typeof parsed === "string") return reply(400, { error: parsed });

  // The replica must hold the private key of the key it presents: a stolen
  // credential alone gets nothing, not even the configuration's public parts.
  const challenge = parsed.challenge ? await takeChallenge(instance.id, parsed.challenge) : null;
  if (!challenge || !verifySyncKeyPossession(challenge, parsed.key, parsed.proofs)) {
    return reply(401, { error: PULL_PROOF_REQUIRED_ERROR, challenge: await issueChallenge(instance.id) });
  }
  const refusal = await checkPullReplicaSyncKey(instance, parsed.key, parsed.proofs, challenge);
  if (refusal) {
    await recordInstanceSyncResult(instance.id, { ok: false, error: refusal });
    // A replica whose SESSION_SECRET was rotated (the old one kept in
    // SESSION_SECRET_PREVIOUS) proves its new key with the pinned one for a
    // challenge: this one, on its next poll.
    return reply(409, { error: refusal, challenge: await issueChallenge(instance.id) });
  }

  const now = nowIso();
  await appDb
    .update(fleetPullReplicas)
    .set({
      lastSeenAt: now,
      lastSeenAddress: address === UNKNOWN_CLIENT_IP ? null : address,
      pollIntervalSeconds: parsed.pollIntervalSeconds,
      lastStatus: JSON.stringify({ status: parsed.status, healthy: parsed.healthy }),
      updatedAt: now,
    })
    .where(eq(fleetPullReplicas.instanceId, instance.id));

  const result = await answer(instance, row, parsed);
  const next = await issueChallenge(instance.id);
  return result.changed
    ? reply(200, { version: PULL_PROTOCOL_VERSION, changed: true, payload: result.payload, challenge: next })
    : reply(200, { version: PULL_PROTOCOL_VERSION, changed: false, challenge: next });
}
