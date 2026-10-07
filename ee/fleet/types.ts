// SPDX-License-Identifier: Elastic-2.0
/**
 * Fleet management: shared types and constants. Safe to import from client
 * components (no server-only dependencies).
 */

export const DRIFT_STATUSES = ["in_sync", "drifted", "unreachable", "older_version", "unknown"] as const;
export type DriftStatus = (typeof DRIFT_STATUSES)[number];

export const DRIFT_STATUS_LABELS: Record<DriftStatus, string> = {
  in_sync: "In sync",
  drifted: "Drifted",
  unreachable: "Unreachable",
  older_version: "Older version",
  unknown: "Unknown",
};

export const ROLLOUT_STATUSES = ["running", "succeeded", "failed", "aborted"] as const;
export type RolloutStatus = (typeof ROLLOUT_STATUSES)[number];

export const ROLLOUT_PHASES = ["canary", "observing", "rolling", "done"] as const;
export type RolloutPhase = (typeof ROLLOUT_PHASES)[number];

export type RolloutKind = "promotion" | "rollback";
export type RolloutTargetStatus = "pending" | "synced" | "failed" | "skipped";

/** Limits of an environment's canary settings. */
export const MAX_CANARY_WAIT_SECONDS = 24 * 60 * 60;
export const DEFAULT_CANARY_WAIT_SECONDS = 300;

export type RevisionView = {
  id: number;
  createdAt: string;
  createdBy: number | null;
  /** Name or email of the user, null for a deleted user. */
  createdByName: string | null;
  summary: string;
  /** SHA-256 of the canonical content (see ee/config-history/fingerprint.ts). */
  fingerprint: string;
  sizeBytes: number;
};

/** Whether a pull replica polls as it should: never polled, polled recently, or missed MISSED_POLLS polls. */
export type PullCheckIn = "never" | "ok" | "missed";

export type FleetInstanceView = {
  id: number;
  name: string;
  /** For a pull replica, its identity ("pull:" and a random id): nothing is sent to it. */
  baseUrl: string;
  /** "pull": a pull replica, which fetches what it should run (see PullReplicaView). */
  syncMode: "push" | "pull";
  /** For a pull replica: its last check-in; null for push instances. */
  pull: { lastSeenAt: string | null; pollIntervalSeconds: number | null; checkIn: PullCheckIn; hasCredential: boolean } | null;
  enabled: boolean;
  environmentId: number | null;
  /** Revision of the last successful push; null when it was the live configuration or nothing was pushed. */
  revisionId: number | null;
  pushedAt: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  drift: {
    /** null until the first push or check. */
    status: DriftStatus | null;
    checkedAt: string | null;
    since: string | null;
    detail: string | null;
    reportedVersion: string | null;
    localChanges: boolean | null;
  };
};

export type EnvironmentView = {
  id: number;
  name: string;
  description: string | null;
  position: number;
  promotionOnly: boolean;
  /** The revision a promotion-only environment is pinned to. */
  revisionId: number | null;
  canary: { enabled: boolean; waitSeconds: number; checkCaddyStatus: boolean };
  instanceIds: number[];
  /** The running rollout into this environment. */
  activeRolloutId: number | null;
  createdAt: string;
  updatedAt: string;
};

export type RolloutTargetView = {
  instanceId: number;
  instanceName: string;
  role: "canary" | "rest";
  status: RolloutTargetStatus;
  error: string | null;
  syncedAt: string | null;
};

export type RolloutView = {
  id: number;
  environmentId: number;
  environmentName: string | null;
  revisionId: number;
  fromRevisionId: number | null;
  kind: RolloutKind;
  /** Where the revision came from: an environment, or null for the master's configuration. */
  sourceEnvironmentId: number | null;
  rollbackOfId: number | null;
  status: RolloutStatus;
  phase: RolloutPhase;
  canary: { instanceId: number | null; waitSeconds: number; checkCaddyStatus: boolean; observeUntil: string | null };
  error: string | null;
  startedBy: number | null;
  /** Name or email of the user who started it; null for the system or a deleted user. */
  startedByName: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  targets: RolloutTargetView[];
};

/**
 * Where a configuration keeps Caddy's certificates (ee/high-availability):
 * the backend and the Redis mode only, never addresses or secrets.
 */
export type CertificateStorageSummary = {
  backend: "local" | "redis";
  redisMode: "standalone" | "cluster" | "sentinel" | null;
};

/** The master itself, which is not one of the instances. */
export type FleetMasterView = {
  /** The release this dashboard runs ("unknown" in development builds). */
  version: string;
  /** What the master's live configuration sets: what instances receiving every change use. */
  certificateStorage: CertificateStorageSummary;
  /** How often the scheduler checks drift (once an environment exists). */
  driftCheckIntervalSeconds: number;
  /** How often a running rollout moves on, and its canary is checked. */
  rolloutStepSeconds: number;
};

export type FleetOverview = {
  mode: "standalone" | "master" | "slave";
  master: FleetMasterView;
  environments: EnvironmentView[];
  instances: FleetInstanceView[];
  revisions: RevisionView[];
  rollouts: RolloutView[];
  pullReplicas: PullReplicaView[];
  /**
   * The certificate storage of each revision an environment, an instance or
   * a running rollout refers to, by revision id.
   */
  revisionStorage: Record<string, CertificateStorageSummary>;
};

/** A pull replica as the master sees it. Holds no secret: the credential is shown once, when issued. */
export type PullReplicaView = {
  /** The instance id. */
  id: number;
  name: string;
  enabled: boolean;
  environmentId: number | null;
  /** False once the credential was revoked: the replica is refused until a new one is issued. */
  hasCredential: boolean;
  /** The start of the credential, to tell credentials apart. */
  credentialPrefix: string | null;
  credentialCreatedAt: string | null;
  /** The sync key pinned for the replica (first contact, rotation proof or an admin). */
  syncKeyPin: { keyId: string; publicKey: string; pinnedAt: string; source: string } | null;
  /** Its last request that authenticated and proved the pinned key. */
  lastSeenAt: string | null;
  /** The client address of that request, as the master saw it. */
  lastSeenAddress: string | null;
  pollIntervalSeconds: number | null;
  checkIn: PullCheckIn;
  /** From its last report. */
  reportedVersion: string | null;
  caddy: { ok: boolean; at: string; code: string | null } | null;
  /** When the master last sent it a configuration, and which revision (null: the live configuration). */
  deliveredAt: string | null;
  deliveredRevisionId: number | null;
  /** A re-sync waiting for the replica to confirm it. */
  resyncPending: boolean;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  createdAt: string;
};

/** What adding a pull replica or rotating its credential returns, once. */
export type IssuedPullCredential = {
  replica: PullReplicaView;
  /** The credential (INSTANCE_PULL_TOKEN); only its hash is kept. */
  credential: string;
  /** Environment variables for the replica, the credential included. */
  env: string;
};
