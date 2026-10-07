// SPDX-License-Identifier: Elastic-2.0
/**
 * Pull replicas: slaves the master cannot reach (behind NAT or a strict
 * firewall) that fetch their configuration from it instead of being pushed
 * to. Each is an instance with syncMode "pull" and a credential of its own,
 * issued here and shown once; only its SHA-256 is kept. The replica polls
 * POST /api/instances/pull (pull-server.ts) with it, and the master answers
 * with what the replica should run, sealed to the replica's pinned sync key,
 * or "no change". See ee/docs/fleet.md.
 *
 * Permissions: fleet:replicas (administrator-level: a credential fetches the
 * whole configuration, its secrets sealed to the replica's key) for changes,
 * fleet:read for reading.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { appDb, nowIso, toIso } from "@/src/lib/db";
import {
  fleetEnvironments,
  fleetInstances,
  fleetPullReplicas,
  fleetRollouts,
  fleetRolloutTargets,
  instances,
} from "@/src/lib/db/schema";
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import { logAuditEvent } from "@/src/lib/audit";
import { config } from "@/src/lib/config";
import { encryptSecret } from "@/src/lib/secret";
import { decodeSyncPublicKey } from "@/src/lib/sync-crypto";
import { sanitizeInstanceSyncError } from "@/src/lib/instance-sync-error";
import { parseReplicaSyncStatus, type ReplicaSyncStatus } from "@/src/lib/instance-sync-fingerprint";
import { getSyncKeyPin, listSyncKeyPins, syncKeyPinIdentity } from "@/src/lib/instance-sync-key-pins";
import { PULL_REPLICA_IDENTITY_PREFIX } from "@/src/lib/instance-sync-view";
import {
  DEFAULT_PULL_INTERVAL_SECONDS,
  ENV_INSTANCE_MASTER_URL,
  ENV_INSTANCE_PULL_INTERVAL,
  ENV_INSTANCE_PULL_TOKEN,
  ENV_INSTANCE_SYNC_MODE,
  PULL_CREDENTIAL_PREFIX,
  isPullCredential,
  pullCredentialHash,
  pullFingerprintToken,
} from "@/ee/fleet/pull-config";
import { deleteInstance, pinInstanceSyncKey } from "@/src/lib/models/instances";
import { readBoolean, readName, rejectUnknownKeys, requireObject } from "@/ee/alerting/validation";
import type { IssuedPullCredential, PullCheckIn, PullReplicaView } from "./types";
import { asc, first } from "@/src/lib/db/ops";

export const PULL_REPLICA_NOT_FOUND = "Pull replica not found";

/** Polls a replica may miss before it counts as not checking in. */
export const MISSED_POLLS = 3;
/** Slack for jitter and slow requests on top of the missed polls. */
const CHECK_IN_GRACE_SECONDS = 15;
/** Characters of a credential shown to tell credentials apart (the prefix plus 6). */
const DISPLAY_PREFIX_LENGTH = PULL_CREDENTIAL_PREFIX.length + 6;

const DEFAULT_APPLY_TIMEOUT_SECONDS = 600;
const MIN_APPLY_TIMEOUT_SECONDS = 60;
const MAX_APPLY_TIMEOUT_SECONDS = 24 * 60 * 60;

type InstanceRow = typeof instances.$inferSelect;
export type PullReplicaRow = typeof fleetPullReplicas.$inferSelect;

// ── Timing ──────────────────────────────────────────────────────────────

/** How long a replica may go without checking in, from its poll interval. */
export function checkInLimitMs(pollIntervalSeconds: number | null): number {
  return (MISSED_POLLS * (pollIntervalSeconds ?? DEFAULT_PULL_INTERVAL_SECONDS) + CHECK_IN_GRACE_SECONDS) * 1000;
}

export function checkInState(row: Pick<PullReplicaRow, "lastSeenAt" | "pollIntervalSeconds"> | null, now: Date = new Date()): PullCheckIn {
  if (!row?.lastSeenAt) return "never";
  return now.getTime() - Date.parse(row.lastSeenAt) > checkInLimitMs(row.pollIntervalSeconds) ? "missed" : "ok";
}

/**
 * How long a rollout waits for a pull replica to report the revision it was
 * asked to take: INSTANCE_PULL_APPLY_TIMEOUT seconds on the master (default
 * 10 minutes, 1 minute to 24 hours), and never less than the polls it may
 * miss before it counts as not checking in.
 */
export function pullApplyTimeoutMs(pollIntervalSeconds: number | null): number {
  const raw = process.env.INSTANCE_PULL_APPLY_TIMEOUT?.trim();
  const configured = raw && /^\d{1,6}$/.test(raw)
    ? Math.min(Math.max(Number(raw), MIN_APPLY_TIMEOUT_SECONDS), MAX_APPLY_TIMEOUT_SECONDS)
    : DEFAULT_APPLY_TIMEOUT_SECONDS;
  return Math.max(configured * 1000, checkInLimitMs(pollIntervalSeconds));
}

// ── Reports ─────────────────────────────────────────────────────────────

/** What a replica last reported, as stored: its sync status and its health. */
export type StoredPullReport = { status: ReplicaSyncStatus; healthy: boolean };

/** The stored report, revalidated; null when there is none or it does not parse. */
export function readPullReport(row: Pick<PullReplicaRow, "lastStatus"> | null): StoredPullReport | null {
  if (!row?.lastStatus) return null;
  try {
    const value = JSON.parse(row.lastStatus) as { status?: unknown; healthy?: unknown };
    const parsed = parseReplicaSyncStatus({ syncStatus: value.status });
    if (parsed.kind !== "ok") return null;
    return { status: parsed.status, healthy: value.healthy === true };
  } catch {
    return null;
  }
}

export async function getPullReplicaRow(instanceId: number): Promise<PullReplicaRow | null> {
  const [row] = await appDb.select().from(fleetPullReplicas).where(eq(fleetPullReplicas.instanceId, instanceId)).limit(1);
  return row ?? null;
}

// ── Views ───────────────────────────────────────────────────────────────

function toView(
  instance: InstanceRow,
  row: PullReplicaRow | null,
  environmentId: number | null,
  pin: PullReplicaView["syncKeyPin"],
  now: Date
): PullReplicaView {
  const report = readPullReport(row);
  return {
    id: instance.id,
    name: instance.name,
    enabled: instance.enabled,
    environmentId,
    hasCredential: Boolean(row?.credentialHash),
    credentialPrefix: row?.credentialHash ? row.credentialPrefix : null,
    credentialCreatedAt: row?.credentialHash ? row.credentialCreatedAt : null,
    syncKeyPin: pin,
    lastSeenAt: row?.lastSeenAt ?? null,
    lastSeenAddress: row?.lastSeenAddress ?? null,
    pollIntervalSeconds: row?.pollIntervalSeconds ?? null,
    checkIn: checkInState(row, now),
    reportedVersion: report?.status.appVersion ?? null,
    caddy: report?.status.caddy ?? null,
    deliveredAt: row?.deliveredAt ?? null,
    deliveredRevisionId: row?.deliveredRevisionId ?? null,
    resyncPending: Boolean(row?.resyncRequestedAt),
    lastSyncAt: instance.lastSyncAt ? toIso(instance.lastSyncAt) : null,
    lastSyncError: sanitizeInstanceSyncError(instance.lastSyncError),
    createdAt: toIso(instance.createdAt)!,
  };
}

function pinView(pin: { keyId: string; publicKey: string; pinnedAt: string; source: string } | null | undefined): PullReplicaView["syncKeyPin"] {
  return pin ? { keyId: pin.keyId, publicKey: pin.publicKey, pinnedAt: pin.pinnedAt, source: pin.source } : null;
}

/** Every pull replica, by name. */
export async function listPullReplicas(): Promise<PullReplicaView[]> {
  const [rows, pins] = await Promise.all([
    appDb
      .select({ instance: instances, pull: fleetPullReplicas, environmentId: fleetInstances.environmentId })
      .from(instances)
      .leftJoin(fleetPullReplicas, eq(fleetPullReplicas.instanceId, instances.id))
      .leftJoin(fleetInstances, eq(fleetInstances.instanceId, instances.id))
      .where(eq(instances.syncMode, "pull"))
      .orderBy(asc(instances.name), asc(instances.id)),
    listSyncKeyPins(),
  ]);
  const pinsByIdentity = new Map(pins.map((pin) => [pin.identity, pin]));
  const now = new Date();
  return rows.map(({ instance, pull, environmentId }) =>
    toView(instance, pull, environmentId ?? null, pinView(pinsByIdentity.get(syncKeyPinIdentity(instance.baseUrl))), now)
  );
}

async function requirePullInstance(id: number): Promise<InstanceRow> {
  const [instance] = await appDb.select().from(instances).where(eq(instances.id, id)).limit(1);
  if (!instance || instance.syncMode !== "pull") throw new ApiClientError(PULL_REPLICA_NOT_FOUND, 404);
  return instance;
}

export async function getPullReplica(id: number): Promise<PullReplicaView> {
  const instance = await requirePullInstance(id);
  const [row, pin, fleet] = await Promise.all([
    getPullReplicaRow(id),
    getSyncKeyPin(instance.baseUrl),
    appDb.select({ environmentId: fleetInstances.environmentId }).from(fleetInstances).where(eq(fleetInstances.instanceId, id)).limit(1),
  ]);
  return toView(instance, row, fleet[0]?.environmentId ?? null, pinView(pin), new Date());
}

// ── Credentials ─────────────────────────────────────────────────────────

type IssuedCredential = {
  credential: string;
  values: Pick<PullReplicaRow, "credentialHash" | "credentialPrefix" | "credentialCreatedAt" | "fingerprintToken">;
};

function issueCredential(): IssuedCredential {
  const credential = `${PULL_CREDENTIAL_PREFIX}${randomBytes(32).toString("base64url")}`;
  return {
    credential,
    values: {
      credentialHash: pullCredentialHash(credential),
      credentialPrefix: credential.slice(0, DISPLAY_PREFIX_LENGTH),
      credentialCreatedAt: nowIso(),
      fingerprintToken: encryptSecret(pullFingerprintToken(credential)),
    },
  };
}

/** The environment variables a replica needs, with `credential`. */
export function pullReplicaEnv(credential: string): string {
  const masterUrl = config.baseUrl.replace(/\/+$/, "");
  const lines = [
    "INSTANCE_MODE=slave",
    `${ENV_INSTANCE_SYNC_MODE}=pull`,
    `${ENV_INSTANCE_MASTER_URL}=${masterUrl}`,
    `${ENV_INSTANCE_PULL_TOKEN}=${credential}`,
    `# ${ENV_INSTANCE_PULL_INTERVAL}=${DEFAULT_PULL_INTERVAL_SECONDS}`,
  ];
  if (masterUrl.startsWith("http:")) {
    lines.push("# The master URL is plain HTTP: only on a trusted network, and only with this set.", "# INSTANCE_SYNC_ALLOW_HTTP=true");
  }
  return lines.join("\n");
}

/**
 * The replica a pull request's Authorization header names, or null when the
 * header is missing, malformed, or no replica holds the credential. Only the
 * credential's hash is looked up.
 */
export async function authenticatePullCredential(
  authorization: string | null
): Promise<{ instance: InstanceRow; row: PullReplicaRow } | null> {
  const match = authorization?.match(/^Bearer\s+(\S+)\s*$/i);
  if (!match || !isPullCredential(match[1])) return null;
  const [found] = await appDb
    .select({ instance: instances, row: fleetPullReplicas })
    .from(fleetPullReplicas)
    .innerJoin(instances, eq(instances.id, fleetPullReplicas.instanceId))
    .where(eq(fleetPullReplicas.credentialHash, pullCredentialHash(match[1])))
    .limit(1);
  if (!found || found.instance.syncMode !== "pull") return null;
  return found;
}

// ── Changes ─────────────────────────────────────────────────────────────

/**
 * Add a pull replica: an enabled instance with syncMode "pull" and a new
 * credential, shown once with the environment variables for the replica.
 * `syncPublicKey` (the replica's sync public key, from its own Instance Sync
 * settings) pins its key at once; otherwise the first key it proves is
 * pinned.
 */
export async function createPullReplica(input: unknown, userId: number): Promise<IssuedPullCredential> {
  const body = requireObject(input, "Body");
  rejectUnknownKeys(body, ["name", "enabled", "syncPublicKey"], "the pull replica");
  const name = readName(body.name);
  const enabled = readBoolean(body.enabled, "enabled", true);
  const publicKey = typeof body.syncPublicKey === "string" && body.syncPublicKey.trim() ? body.syncPublicKey.trim() : null;
  if (
    (body.syncPublicKey !== undefined && body.syncPublicKey !== null && typeof body.syncPublicKey !== "string") ||
    (publicKey !== null && !decodeSyncPublicKey(publicKey))
  ) {
    throw new ApiValidationError(
      "syncPublicKey must be the replica's sync public key: 32 bytes, base64 (as its Instance Sync settings show it), or null"
    );
  }

  const issued = issueCredential();
  const now = nowIso();
  const id = await appDb.transaction(async (tx) => {
    const instance = (await first(tx
      .insert(instances)
      .values({
        name,
        baseUrl: `${PULL_REPLICA_IDENTITY_PREFIX}${randomUUID()}`,
        apiToken: "",
        enabled,
        syncMode: "pull",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: instances.id })))!;
    await tx.insert(fleetPullReplicas).values({ instanceId: instance.id, ...issued.values, createdAt: now, updatedAt: now });
    return instance.id;
  });
  await logAuditEvent({
    userId,
    action: "fleet_pull_replica_created",
    entityType: "instance",
    entityId: id,
    summary: `Added pull replica "${name}" (credential ${issued.values.credentialPrefix}…)`,
    data: { credentialPrefix: issued.values.credentialPrefix, enabled },
  });
  if (publicKey !== null) {
    try {
      await pinInstanceSyncKey(id, publicKey, userId);
    } catch (error) {
      // Nothing half-made is left behind: the replica is removed again.
      await deleteInstance(id, userId);
      throw error;
    }
  }
  return { replica: await getPullReplica(id), credential: issued.credential, env: pullReplicaEnv(issued.credential) };
}

/**
 * Replace the credential of pull replica `id` (also one that was revoked).
 * The old one stops working at once; the replica keeps its key pin, and
 * receives its configuration once more (its fingerprints are keyed with the
 * credential).
 */
export async function rotatePullCredential(id: number, userId: number): Promise<IssuedPullCredential> {
  const instance = await requirePullInstance(id);
  const issued = issueCredential();
  const now = nowIso();
  await appDb
    .insert(fleetPullReplicas)
    .values({ instanceId: id, ...issued.values, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: fleetPullReplicas.instanceId, set: { ...issued.values, updatedAt: now } });
  await logAuditEvent({
    userId,
    action: "fleet_pull_credential_rotated",
    entityType: "instance",
    entityId: id,
    summary: `Issued a new credential (${issued.values.credentialPrefix}…) for pull replica "${instance.name}"`,
    data: { credentialPrefix: issued.values.credentialPrefix },
  });
  return { replica: await getPullReplica(id), credential: issued.credential, env: pullReplicaEnv(issued.credential) };
}

/**
 * Revoke the credential of pull replica `id`: its requests are refused from
 * now on. The replica, its key pin and its history stay; rotating issues a
 * new credential.
 */
export async function revokePullCredential(id: number, userId: number): Promise<PullReplicaView> {
  const instance = await requirePullInstance(id);
  const row = await getPullReplicaRow(id);
  if (row?.credentialHash) {
    await appDb
      .update(fleetPullReplicas)
      .set({ credentialHash: null, credentialPrefix: null, credentialCreatedAt: null, fingerprintToken: null, updatedAt: nowIso() })
      .where(eq(fleetPullReplicas.instanceId, id));
    await logAuditEvent({
      userId,
      action: "fleet_pull_credential_revoked",
      entityType: "instance",
      entityId: id,
      summary: `Revoked the credential (${row.credentialPrefix}…) of pull replica "${instance.name}"`,
      data: { credentialPrefix: row.credentialPrefix },
    });
  }
  return getPullReplica(id);
}

/** Delete pull replica `id` with its credential, key pin and fleet records. */
export async function deletePullReplica(id: number, userId: number): Promise<void> {
  const instance = await requirePullInstance(id);
  await deleteInstance(id, userId);
  await logAuditEvent({
    userId,
    action: "fleet_pull_replica_deleted",
    entityType: "instance",
    entityId: id,
    summary: `Deleted pull replica "${instance.name}"`,
  });
}

// ── What a replica should run ───────────────────────────────────────────

/**
 * What a pull replica should run now:
 * - outside a promotion-only environment: the master's configuration, with
 *   every change, as a pushed instance receives it;
 * - in one: the revision a running rollout asked it to take; else the
 *   revision a re-sync asked for; else the revision it last confirmed; else
 *   nothing (it keeps what it has, like a pushed instance that joins).
 * `force`: send it even when the replica reports it runs it (a re-sync not
 * sent yet).
 */
export type PullDesired =
  | { kind: "none" }
  | { kind: "live"; force: boolean }
  | { kind: "revision"; revisionId: number; force: boolean; rolloutTarget: { requestedAt: string } | null };

export async function resolvePullDesired(instanceId: number, row: PullReplicaRow): Promise<PullDesired> {
  const resyncPending = row.resyncRequestedAt !== null && (!row.deliveredAt || row.deliveredAt < row.resyncRequestedAt);
  const [fleet] = await appDb
    .select({ environmentId: fleetInstances.environmentId, revisionId: fleetInstances.revisionId, promotionOnly: fleetEnvironments.promotionOnly })
    .from(fleetInstances)
    .leftJoin(fleetEnvironments, eq(fleetEnvironments.id, fleetInstances.environmentId))
    .where(eq(fleetInstances.instanceId, instanceId))
    .limit(1);
  if (!fleet?.environmentId || !fleet.promotionOnly) return { kind: "live", force: resyncPending };

  const [target] = await appDb
    .select({ revisionId: fleetRollouts.revisionId, requestedAt: fleetRolloutTargets.requestedAt })
    .from(fleetRolloutTargets)
    .innerJoin(fleetRollouts, eq(fleetRollouts.id, fleetRolloutTargets.rolloutId))
    .where(
      and(
        eq(fleetRolloutTargets.instanceId, instanceId),
        eq(fleetRolloutTargets.status, "pending"),
        isNotNull(fleetRolloutTargets.requestedAt),
        eq(fleetRollouts.status, "running"),
        eq(fleetRollouts.environmentId, fleet.environmentId)
      )
    )
    .limit(1);
  if (target?.requestedAt) {
    return { kind: "revision", revisionId: target.revisionId, force: false, rolloutTarget: { requestedAt: target.requestedAt } };
  }
  if (row.resyncRequestedAt !== null && row.resyncRevisionId !== null) {
    return { kind: "revision", revisionId: row.resyncRevisionId, force: resyncPending, rolloutTarget: null };
  }
  if (fleet.revisionId !== null) return { kind: "revision", revisionId: fleet.revisionId, force: false, rolloutTarget: null };
  return { kind: "none" };
}

/**
 * Ask pull replica `instanceId` to take what it should run once more (see
 * resyncInstance in rollouts.ts): `revisionId`, or the master's configuration
 * for null. It is sent with the replica's next poll, also when the replica
 * reports it runs it already, and counts once the replica confirms it.
 */
export async function requestPullResync(instanceId: number, revisionId: number | null): Promise<void> {
  const now = nowIso();
  await appDb
    .insert(fleetPullReplicas)
    .values({ instanceId, resyncRequestedAt: now, resyncRevisionId: revisionId, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: fleetPullReplicas.instanceId,
      set: { resyncRequestedAt: now, resyncRevisionId: revisionId, updatedAt: now },
    });
}
