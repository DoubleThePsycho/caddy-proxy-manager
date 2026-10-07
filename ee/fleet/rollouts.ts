// SPDX-License-Identifier: Elastic-2.0
/**
 * Promotions and rollouts.
 *
 * A promotion rolls one revision out to a promotion-only environment: what
 * the environment before it runs (its pinned revision, or the master's
 * configuration when it receives every change), or for the first
 * environment the master's current configuration. With a canary the revision
 * goes to one instance first; the rollout then watches that instance for the
 * configured time (its health endpoint and, optionally, its Caddy apply
 * status and fingerprint) before it continues to the rest. A failed push or
 * check stops the rollout and marks it failed: instances not reached yet
 * stay on the previous revision, and so does the environment. A rollback
 * promotes the revision the environment ran before a rollout.
 *
 * Rollouts advance in the fleet scheduler (scheduler.ts), a step at a time,
 * with all their state in the database, so a restart picks a rollout up
 * where it stopped: a push that was cut off is sent again (pushing the same
 * revision twice is harmless).
 *
 * Pull replicas (pull-replicas.ts) are not pushed to: the step marks their
 * target as requested, the replica fetches the revision with its next poll,
 * and the target is synced once the replica reports it runs it (and its
 * Caddy took it), or failed when it reports it could not apply it or has
 * not confirmed it by the pull timeout. Their canary checks read the
 * replica's reports instead of asking it.
 */
import { and, eq, inArray } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { fleetEnvironments, fleetInstances, fleetRevisions, fleetRollouts, fleetRolloutTargets, instances, users } from "@/src/lib/db/schema";
import { ApiClientError, ApiConflictError, ApiValidationError } from "@/src/lib/api-errors";
import { logAuditEvent } from "@/src/lib/audit";
import { emptyConfigContent, type ConfigContent } from "@/src/lib/config-content";
import {
  INSTANCE_SYNC_LOCK,
  buildSyncPayload,
  buildSyncPayloadFromContent,
  fetchInstanceHealth,
  fetchInstanceSyncStatus,
  getInstanceMode,
  syncInstanceWithPayload,
  type InstanceSyncOutcome,
  type SyncPayload,
} from "@/src/lib/instance-sync";
import { configFingerprint } from "@/ee/config-history/fingerprint";
import { diffConfigContent, type ConfigDiff } from "@/ee/config-history/diff";
import { readBoolean, readInteger, rejectUnknownKeys, requireObject } from "@/ee/alerting/validation";
import {
  INSTANCE_NOT_FOUND,
  getEnvironmentRow,
  getInstanceEnvironmentId,
  getInstanceRow,
  getRunningRolloutId,
  listEnvironmentRows,
  listFleetInstances,
  requireEnvironmentRow,
  type EnvironmentRow,
} from "./environments";
import {
  captureCurrentRevision,
  currentFleetContent,
  getRevisionContent,
  pruneFleetHistory,
} from "./revisions";
import {
  checkInState,
  getPullReplicaRow,
  pullApplyTimeoutMs,
  readPullReport,
  requestPullResync,
} from "./pull-replicas";
import {
  MAX_CANARY_WAIT_SECONDS,
  ROLLOUT_PHASES,
  ROLLOUT_STATUSES,
  type FleetInstanceView,
  type RolloutKind,
  type RolloutPhase,
  type RolloutStatus,
  type RolloutTargetStatus,
  type RolloutView,
} from "./types";
import { asc, desc, first as dbFirst } from "@/src/lib/db/ops";
import { tryWithClusterLock, withClusterLock } from "@/src/lib/db/locks";

export const ROLLOUT_NOT_FOUND = "Rollout not found";
export const NOT_MASTER_ERROR = "Fleet management needs this instance in master mode";

/** Instances pushed to at once in the rolling phase. */
const PUSH_CONCURRENCY = 4;
const MAX_LISTED_NAMES = 5;

type RolloutRow = typeof fleetRollouts.$inferSelect;
type TargetRow = typeof fleetRolloutTargets.$inferSelect;
type InstanceRow = typeof instances.$inferSelect;

export type CanaryPlan = { enabled: boolean; instanceId: number | null; waitSeconds: number; checkCaddyStatus: boolean };

// ── Locks and the scheduler hook ────────────────────────────────────────

/**
 * The cluster lock (src/lib/db/locks.ts) a pass of the rollout engine holds:
 * one pass at a time in the deployment; a pass that finds it taken is
 * skipped.
 */
export const FLEET_ROLLOUT_LOCK = "fleet-rollouts";

/** The cluster lock of fleet pushes to one instance (a rollout step, a re-sync): one at a time, on any replica. */
export function fleetPushLockName(instanceId: number): string {
  return `fleet-push:${instanceId}`;
}

const store = globalThis as typeof globalThis & {
  __ingressiFleetRollouts?: { kick: (() => void) | null };
};
const state = (store.__ingressiFleetRollouts ??= { kick: null });

/** Set by the scheduler: runs a rollout step soon after a rollout starts. Unset in tests. */
export function setRolloutKick(kick: (() => void) | null): void {
  state.kick = kick;
}

/** Runs a rollout step soon, when the scheduler runs (a pull replica confirmed a revision). */
export function kickRollouts(): void {
  state.kick?.();
}

// ── Views ───────────────────────────────────────────────────────────────

function readStatus(value: string): RolloutStatus {
  return (ROLLOUT_STATUSES as readonly string[]).includes(value) ? (value as RolloutStatus) : "failed";
}

function readPhase(value: string): RolloutPhase {
  return (ROLLOUT_PHASES as readonly string[]).includes(value) ? (value as RolloutPhase) : "done";
}

function toView(row: RolloutRow, targets: TargetRow[], environmentName: string | null, startedByName: string | null): RolloutView {
  return {
    id: row.id,
    environmentId: row.environmentId,
    environmentName,
    revisionId: row.revisionId,
    fromRevisionId: row.fromRevisionId,
    kind: row.kind === "rollback" ? "rollback" : "promotion",
    sourceEnvironmentId: row.sourceEnvironmentId,
    rollbackOfId: row.rollbackOfId,
    status: readStatus(row.status),
    phase: readPhase(row.phase),
    canary: {
      instanceId: row.canaryInstanceId,
      waitSeconds: row.canaryWaitSeconds,
      checkCaddyStatus: row.checkCaddyStatus,
      observeUntil: row.observeUntil,
    },
    error: row.error,
    startedBy: row.startedBy,
    startedByName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
    targets: targets
      .filter((target) => target.rolloutId === row.id)
      .map((target) => ({
        instanceId: target.instanceId,
        instanceName: target.instanceName,
        role: target.role === "canary" ? "canary" : "rest",
        status: (["pending", "synced", "failed", "skipped"].includes(target.status) ? target.status : "skipped") as RolloutTargetStatus,
        error: target.error,
        syncedAt: target.syncedAt,
      })),
  };
}

async function viewsOf(rows: RolloutRow[]): Promise<RolloutView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const userIds = [...new Set(rows.flatMap((row) => (row.startedBy === null ? [] : [row.startedBy])))];
  const [targets, environments, starters] = await Promise.all([
    appDb.select().from(fleetRolloutTargets).where(inArray(fleetRolloutTargets.rolloutId, ids)).orderBy(asc(fleetRolloutTargets.id)),
    appDb.select({ id: fleetEnvironments.id, name: fleetEnvironments.name }).from(fleetEnvironments),
    userIds.length === 0
      ? Promise.resolve([])
      : appDb.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, userIds)),
  ]);
  const names = new Map(environments.map((environment) => [environment.id, environment.name]));
  const starterNames = new Map(starters.map((user) => [user.id, user.name || user.email || null]));
  return rows.map((row) =>
    toView(row, targets, names.get(row.environmentId) ?? null, row.startedBy === null ? null : (starterNames.get(row.startedBy) ?? null))
  );
}

export async function listRollouts(options: { environmentId?: number; limit?: number; offset?: number } = {}): Promise<{ rollouts: RolloutView[]; total: number }> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 25), 1), 200);
  const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
  const where = options.environmentId !== undefined ? eq(fleetRollouts.environmentId, options.environmentId) : undefined;
  const rows = await appDb.select().from(fleetRollouts).where(where).orderBy(desc(fleetRollouts.id)).limit(limit).offset(offset);
  const total = (await appDb.select({ id: fleetRollouts.id }).from(fleetRollouts).where(where)).length;
  return { rollouts: await viewsOf(rows), total };
}

async function getRolloutRow(id: number): Promise<RolloutRow | null> {
  const [row] = await appDb.select().from(fleetRollouts).where(eq(fleetRollouts.id, id)).limit(1);
  return row ?? null;
}

export async function getRollout(id: number): Promise<RolloutView> {
  const row = await getRolloutRow(id);
  if (!row) throw new ApiClientError(ROLLOUT_NOT_FOUND, 404);
  return (await viewsOf([row]))[0];
}

// ── Starting ────────────────────────────────────────────────────────────

async function assertMaster(): Promise<void> {
  if ((await getInstanceMode()) !== "master") throw new ApiConflictError(NOT_MASTER_ERROR);
}

function assertPromotionOnly(environment: EnvironmentRow): void {
  if (!environment.promotionOnly) {
    throw new ApiConflictError(
      `Environment "${environment.name}" receives every change at once; promotions are for promotion-only environments`
    );
  }
}

/**
 * Where a promotion into `environment` takes its revision from: the
 * environment before it in the promotion order, or the master's
 * configuration for the first one. `revisionId` is null when that is the
 * master's current configuration (captured when the promotion starts).
 */
async function resolvePromotionSource(environment: EnvironmentRow): Promise<{ source: EnvironmentRow | null; revisionId: number | null }> {
  const environments = await listEnvironmentRows();
  const index = environments.findIndex((candidate) => candidate.id === environment.id);
  const source = index > 0 ? environments[index - 1] : null;
  if (!source || !source.promotionOnly) return { source, revisionId: null };
  if (source.revisionId === null) {
    throw new ApiConflictError(`Environment "${source.name}" has no revision to promote yet; promote one to it first`);
  }
  return { source, revisionId: source.revisionId };
}

/** Enabled instances of environment `id`, by id: the targets of a rollout into it. */
async function environmentTargets(environmentId: number): Promise<InstanceRow[]> {
  return appDb
    .select({ instance: instances })
    .from(fleetInstances)
    .innerJoin(instances, eq(instances.id, fleetInstances.instanceId))
    .where(and(eq(fleetInstances.environmentId, environmentId), eq(instances.enabled, true)))
    .orderBy(asc(instances.id))
    .then((rows) => rows.map((row) => row.instance));
}

function canaryDefaults(environment: EnvironmentRow, enabled: boolean): CanaryPlan {
  return {
    enabled,
    instanceId: null,
    waitSeconds: environment.canaryWaitSeconds,
    checkCaddyStatus: environment.checkCaddyStatus,
  };
}

/** A canary given in a request (undefined: the defaults; false or null: no canary). */
function readCanary(raw: unknown, defaults: CanaryPlan): CanaryPlan {
  if (raw === undefined) return defaults;
  if (raw === null || raw === false) return { ...defaults, enabled: false };
  const body = requireObject(raw, "canary");
  rejectUnknownKeys(body, ["enabled", "instanceId", "waitSeconds", "checkCaddyStatus"], "canary");
  const plan: CanaryPlan = { ...defaults, enabled: readBoolean(body.enabled, "canary.enabled", true) };
  if (body.instanceId !== undefined && body.instanceId !== null) {
    plan.instanceId = readInteger(body.instanceId, "canary.instanceId", 1, Number.MAX_SAFE_INTEGER);
  }
  if (body.waitSeconds !== undefined) plan.waitSeconds = readInteger(body.waitSeconds, "canary.waitSeconds", 0, MAX_CANARY_WAIT_SECONDS);
  if (body.checkCaddyStatus !== undefined) plan.checkCaddyStatus = readBoolean(body.checkCaddyStatus, "canary.checkCaddyStatus", true);
  return plan;
}

type NewRollout = {
  environment: EnvironmentRow;
  revisionId: number;
  kind: RolloutKind;
  sourceEnvironmentId: number | null;
  rollbackOfId: number | null;
  canary: CanaryPlan;
  userId: number;
};

/** Store a rollout and its targets; one without targets is done at once. Returns its id. */
async function createRollout(input: NewRollout): Promise<number> {
  const targets = await environmentTargets(input.environment.id);
  let canaryId: number | null = null;
  if (input.canary.enabled && targets.length > 0) {
    canaryId = input.canary.instanceId ?? targets[0].id;
    if (!targets.some((target) => target.id === canaryId)) {
      throw new ApiValidationError("canary.instanceId must be an enabled instance of the environment");
    }
  }
  const now = nowIso();
  const done = targets.length === 0;
  return await appDb.transaction(async (tx) => {
    // Checked again inside the transaction: two promotions started at once.
    const running = await dbFirst(tx
      .select({ id: fleetRollouts.id })
      .from(fleetRollouts)
      .where(and(eq(fleetRollouts.environmentId, input.environment.id), eq(fleetRollouts.status, "running")))
      .limit(1));
    if (running) throw new ApiConflictError(`A rollout is already running in environment "${input.environment.name}"`);
    const row = (await dbFirst(tx
      .insert(fleetRollouts)
      .values({
        environmentId: input.environment.id,
        revisionId: input.revisionId,
        fromRevisionId: input.environment.revisionId,
        kind: input.kind,
        sourceEnvironmentId: input.sourceEnvironmentId,
        rollbackOfId: input.rollbackOfId,
        status: done ? "succeeded" : "running",
        phase: done ? "done" : canaryId !== null ? "canary" : "rolling",
        canaryInstanceId: canaryId,
        canaryWaitSeconds: canaryId !== null ? input.canary.waitSeconds : 0,
        checkCaddyStatus: canaryId !== null && input.canary.checkCaddyStatus,
        startedBy: input.userId,
        createdAt: now,
        updatedAt: now,
        finishedAt: done ? now : null,
      })
      .returning({ id: fleetRollouts.id })))!;
    for (const target of targets) {
      await tx.insert(fleetRolloutTargets)
        .values({
          rolloutId: row.id,
          instanceId: target.id,
          instanceName: target.name,
          role: target.id === canaryId ? "canary" : "rest",
          status: "pending",
        });
    }
    if (done) {
      await tx.update(fleetEnvironments)
        .set({ revisionId: input.revisionId, updatedAt: now })
        .where(eq(fleetEnvironments.id, input.environment.id));
    }
    return row.id;
  });
}

async function revisionFingerprint(id: number | null): Promise<string | null> {
  if (id === null) return null;
  const [row] = await appDb.select({ fingerprint: fleetRevisions.fingerprint }).from(fleetRevisions).where(eq(fleetRevisions.id, id)).limit(1);
  return row?.fingerprint ?? null;
}

/** True when every enabled instance of the environment last received `revisionId`. */
async function environmentRuns(environment: EnvironmentRow, revisionId: number): Promise<boolean> {
  if (environment.revisionId !== revisionId) return false;
  const targets = await environmentTargets(environment.id);
  if (targets.length === 0) return true;
  const rows = await appDb
    .select({ id: fleetInstances.instanceId, revisionId: fleetInstances.revisionId })
    .from(fleetInstances)
    .where(inArray(fleetInstances.instanceId, targets.map((target) => target.id)));
  return rows.length === targets.length && rows.every((row) => row.revisionId === revisionId);
}

export type PromotionPreview = {
  environmentId: number;
  environmentName: string;
  source: {
    /** The environment the revision comes from; null for the master's configuration. */
    environmentId: number | null;
    environmentName: string | null;
    /** The revision promoted; null when it is the master's current configuration, captured when the promotion starts. */
    revisionId: number | null;
  };
  currentRevisionId: number | null;
  /** What the promotion changes in the configuration the environment is pinned to. */
  diff: ConfigDiff;
  /** The environment and all its enabled instances already run this configuration. */
  upToDate: boolean;
  targets: Array<{ instanceId: number; name: string; revisionId: number | null }>;
  canary: CanaryPlan;
  warnings: string[];
};

/** What promoting into environment `environmentId` would roll out, and the diff against what it runs. */
export async function previewPromotion(environmentId: number): Promise<PromotionPreview> {
  const environment = await requireEnvironmentRow(environmentId);
  assertPromotionOnly(environment);
  const { source, revisionId } = await resolvePromotionSource(environment);
  const content = revisionId === null ? await currentFleetContent() : await getRevisionContent(revisionId);
  if (!content) throw new ApiConflictError(`Revision #${revisionId} is no longer kept`);
  const current = environment.revisionId === null ? null : await getRevisionContent(environment.revisionId);

  const fleetInstancesView = await listFleetInstances();
  const targets = (await environmentTargets(environment.id)).map((instance) => ({
    instanceId: instance.id,
    name: instance.name,
    revisionId: fleetInstancesView.find((item) => item.id === instance.id)?.revisionId ?? null,
  }));

  const warnings: string[] = [];
  if (environment.revisionId !== null && !current) {
    warnings.push(`Revision #${environment.revisionId}, which the environment is pinned to, is no longer kept; the diff is against an empty configuration`);
  }
  if (source && !source.promotionOnly) {
    const struggling = fleetInstancesView.filter(
      (item) => item.environmentId === source.id && item.enabled && (item.lastSyncError !== null || item.drift.status === "drifted")
    );
    if (struggling.length > 0) {
      warnings.push(
        `In "${source.name}", ${struggling.slice(0, MAX_LISTED_NAMES).map((item) => `"${item.name}"`).join(", ")}` +
        `${struggling.length > MAX_LISTED_NAMES ? " and others" : ""} did not take the last sync or drifted: ` +
        "it may not run the master's current configuration"
      );
    }
  }
  const disabled = fleetInstancesView.filter((item) => item.environmentId === environment.id && !item.enabled);
  if (disabled.length > 0) warnings.push(`${disabled.length} disabled instance(s) of "${environment.name}" are left out`);
  if (targets.length === 0) warnings.push(`"${environment.name}" has no enabled instances: the promotion only pins the revision`);

  const sourceFingerprint = revisionId === null ? configFingerprint(content) : await revisionFingerprint(revisionId);
  const upToDate =
    environment.revisionId !== null &&
    sourceFingerprint === (await revisionFingerprint(environment.revisionId)) &&
    (await environmentRuns(environment, environment.revisionId));

  return {
    environmentId: environment.id,
    environmentName: environment.name,
    source: { environmentId: source?.id ?? null, environmentName: source?.name ?? null, revisionId },
    currentRevisionId: environment.revisionId,
    diff: diffConfigContent(current ?? emptyConfigContent(), content),
    upToDate,
    targets,
    canary: canaryDefaults(environment, environment.canaryEnabled),
    warnings,
  };
}

/**
 * Start a promotion into a promotion-only environment (`environmentId`),
 * from the environment before it (see resolvePromotionSource), with the
 * environment's canary settings unless `canary` overrides them. Needs
 * master mode. Refused while another rollout runs there and when the
 * environment and all its instances already run that configuration.
 */
export async function startPromotion(input: unknown, userId: number): Promise<RolloutView> {
  await assertMaster();
  const body = requireObject(input, "Body");
  rejectUnknownKeys(body, ["environmentId", "canary"], "the promotion");
  const environmentId = readInteger(body.environmentId, "environmentId", 1, Number.MAX_SAFE_INTEGER);
  const environment = await requireEnvironmentRow(environmentId);
  assertPromotionOnly(environment);
  const canary = readCanary(body.canary, canaryDefaults(environment, environment.canaryEnabled));
  if ((await getRunningRolloutId(environment.id)) !== null) {
    throw new ApiConflictError(`A rollout is already running in environment "${environment.name}"`);
  }

  const { source, revisionId: sourceRevisionId } = await resolvePromotionSource(environment);
  let revisionId = sourceRevisionId;
  if (revisionId === null) {
    revisionId = (await captureCurrentRevision(userId)).revision.id;
  } else if (!(await getRevisionContent(revisionId))) {
    throw new ApiConflictError(`Revision #${revisionId} is no longer kept`);
  }
  if (await environmentRuns(environment, revisionId)) {
    throw new ApiConflictError(`Environment "${environment.name}" and all its instances already run revision #${revisionId}`);
  }

  const id = await createRollout({
    environment,
    revisionId,
    kind: "promotion",
    sourceEnvironmentId: source?.id ?? null,
    rollbackOfId: null,
    canary,
    userId,
  });
  await logAuditEvent({
    userId,
    action: "fleet_rollout_started",
    entityType: "fleet_rollout",
    entityId: id,
    summary:
      `Started promoting revision #${revisionId} to fleet environment "${environment.name}" from ` +
      (source ? `environment "${source.name}"` : "the master's configuration"),
    data: { environmentId: environment.id, revisionId, fromRevisionId: environment.revisionId, canary },
  });
  state.kick?.();
  await pruneFleetHistory().catch(() => undefined);
  return getRollout(id);
}

/**
 * Roll back rollout `id`: promote the revision its environment ran before
 * it, without a canary unless `canary` asks for one. Only for the latest
 * rollout of an environment once it has stopped.
 */
export async function rollbackRollout(id: number, input: unknown, userId: number): Promise<RolloutView> {
  await assertMaster();
  const body = input === undefined || input === null ? {} : requireObject(input, "Body");
  rejectUnknownKeys(body, ["canary"], "the rollback");
  const rollout = await getRolloutRow(id);
  if (!rollout) throw new ApiClientError(ROLLOUT_NOT_FOUND, 404);
  if (rollout.status === "running") throw new ApiConflictError("The rollout is still running; abort it first");
  const environment = await getEnvironmentRow(rollout.environmentId);
  if (!environment) throw new ApiConflictError("The rollout's environment no longer exists");
  assertPromotionOnly(environment);
  const [latest] = await appDb
    .select({ id: fleetRollouts.id })
    .from(fleetRollouts)
    .where(eq(fleetRollouts.environmentId, environment.id))
    .orderBy(desc(fleetRollouts.id))
    .limit(1);
  if (latest?.id !== rollout.id) {
    throw new ApiConflictError("Only the latest rollout of an environment can be rolled back");
  }
  if (rollout.fromRevisionId === null) {
    throw new ApiConflictError(`Environment "${environment.name}" ran no revision before this rollout; there is nothing to roll back to`);
  }
  if (!(await getRevisionContent(rollout.fromRevisionId))) {
    throw new ApiConflictError(`Revision #${rollout.fromRevisionId} is no longer kept`);
  }
  const canary = readCanary(body.canary, canaryDefaults(environment, false));
  const rollbackId = await createRollout({
    environment,
    revisionId: rollout.fromRevisionId,
    kind: "rollback",
    sourceEnvironmentId: null,
    rollbackOfId: rollout.id,
    canary,
    userId,
  });
  await logAuditEvent({
    userId,
    action: "fleet_rollback_started",
    entityType: "fleet_rollout",
    entityId: rollbackId,
    summary: `Started rolling fleet environment "${environment.name}" back to revision #${rollout.fromRevisionId} (rollout #${rollout.id})`,
    data: { environmentId: environment.id, revisionId: rollout.fromRevisionId, rollbackOfId: rollout.id, canary },
  });
  state.kick?.();
  return getRollout(rollbackId);
}

/**
 * Stop a running rollout. Instances already pushed keep the new revision;
 * the others and the environment stay where they are. A push in progress
 * completes.
 */
export async function abortRollout(id: number, userId: number): Promise<RolloutView> {
  const rollout = await getRolloutRow(id);
  if (!rollout) throw new ApiClientError(ROLLOUT_NOT_FOUND, 404);
  if (rollout.status !== "running") throw new ApiConflictError("The rollout is not running");
  const now = nowIso();
  await appDb.transaction(async (tx) => {
    await tx.update(fleetRollouts)
      .set({ status: "aborted", phase: "done", error: "Aborted", updatedAt: now, finishedAt: now })
      .where(and(eq(fleetRollouts.id, id), eq(fleetRollouts.status, "running")));
    await tx.update(fleetRolloutTargets)
      .set({ status: "skipped", error: "Not pushed: the rollout was aborted" })
      .where(and(eq(fleetRolloutTargets.rolloutId, id), eq(fleetRolloutTargets.status, "pending")));
  });
  const environment = await getEnvironmentRow(rollout.environmentId);
  await logAuditEvent({
    userId,
    action: "fleet_rollout_aborted",
    entityType: "fleet_rollout",
    entityId: id,
    summary: `Aborted rollout #${id} of revision #${rollout.revisionId} to fleet environment "${environment?.name ?? rollout.environmentId}"`,
  });
  return getRollout(id);
}

// ── Re-sync ─────────────────────────────────────────────────────────────

export type ResyncResult = {
  ok: boolean;
  error: string | null;
  revisionId: number | null;
  instance: FleetInstanceView | null;
  /** A pull replica: the re-sync is sent with its next poll and confirmed by its report. */
  pending?: boolean;
};

/**
 * Push to one instance what it should run: its promotion-only environment's
 * revision, or the master's configuration. The manual repair for a drifted
 * instance. A pull replica is asked to take it with its next poll, even when
 * it reports it runs it (which overwrites changes made on it). Refused
 * while a rollout runs in the instance's environment.
 */
export async function resyncInstance(instanceId: number, userId: number): Promise<ResyncResult> {
  await assertMaster();
  const instance = await getInstanceRow(instanceId);
  if (!instance) throw new ApiClientError(INSTANCE_NOT_FOUND, 404);
  if (!instance.enabled) throw new ApiConflictError(`Instance "${instance.name}" is disabled`);
  const environmentId = await getInstanceEnvironmentId(instanceId);
  const environment = environmentId === null ? null : await getEnvironmentRow(environmentId);

  let revisionId: number | null = null;
  let content: ConfigContent | null = null;
  if (environment?.promotionOnly) {
    if ((await getRunningRolloutId(environment.id)) !== null) {
      throw new ApiConflictError(`A rollout is running in environment "${environment.name}"; wait for it or abort it first`);
    }
    if (environment.revisionId === null) {
      throw new ApiConflictError(`Environment "${environment.name}" has no revision yet; promote one to it first`);
    }
    content = await getRevisionContent(environment.revisionId);
    if (!content) throw new ApiConflictError(`Revision #${environment.revisionId} is no longer kept`);
    revisionId = environment.revisionId;
  }

  if (instance.syncMode === "pull") {
    await requestPullResync(instanceId, revisionId);
    await logAuditEvent({
      userId,
      action: "fleet_instance_resynced",
      entityType: "instance",
      entityId: instanceId,
      summary:
        `Asked pull replica "${instance.name}" to take ${revisionId === null ? "the master's configuration" : `revision #${revisionId}`} ` +
        "again with its next poll",
      data: { revisionId, pull: true },
    });
    return {
      ok: true,
      error: null,
      revisionId,
      pending: true,
      instance: (await listFleetInstances()).find((item) => item.id === instanceId) ?? null,
    };
  }
  const push = async (): Promise<InstanceSyncOutcome> => {
    const payload: SyncPayload = content ? await buildSyncPayloadFromContent(content) : await buildSyncPayload();
    const pushed = await tryWithClusterLock(fleetPushLockName(instanceId), () => syncInstanceWithPayload(instance, payload, { revisionId }));
    if (!pushed.acquired) throw new ApiConflictError(`A push to "${instance.name}" is already in progress`);
    return pushed.value;
  };
  // The master's configuration is built and pushed under the sync lock, so
  // it never reaches the instance after a newer sync did.
  const outcome = content ? await push() : await withClusterLock(INSTANCE_SYNC_LOCK, push);
  await logAuditEvent({
    userId,
    action: "fleet_instance_resynced",
    entityType: "instance",
    entityId: instanceId,
    summary:
      `Re-synced instance "${instance.name}" with ${revisionId === null ? "the master's configuration" : `revision #${revisionId}`}` +
      (outcome.ok ? "" : ` (failed: ${outcome.error})`),
    data: { revisionId, ok: outcome.ok },
  });
  return {
    ok: outcome.ok,
    error: outcome.ok ? null : outcome.error,
    revisionId,
    instance: (await listFleetInstances()).find((item) => item.id === instanceId) ?? null,
  };
}

// ── The engine ──────────────────────────────────────────────────────────

/** Built payloads of the revisions a tick pushes: decrypting the secrets once per tick. */
type TickContext = { now: Date; payloads: Map<number, Promise<SyncPayload>> };

class RevisionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevisionUnavailableError";
  }
}

function revisionPayload(context: TickContext, revisionId: number): Promise<SyncPayload> {
  let payload = context.payloads.get(revisionId);
  if (!payload) {
    payload = (async () => {
      let content: ConfigContent | null;
      try {
        content = await getRevisionContent(revisionId);
      } catch {
        throw new RevisionUnavailableError(`Revision #${revisionId} cannot be read by this release`);
      }
      if (!content) throw new RevisionUnavailableError(`Revision #${revisionId} is no longer kept`);
      try {
        return await buildSyncPayloadFromContent(content);
      } catch (error) {
        console.warn(`[fleet] Revision #${revisionId} could not be prepared for sync:`, error instanceof Error ? error.name : typeof error);
        throw new RevisionUnavailableError(`Revision #${revisionId} could not be prepared for sync (a stored secret cannot be decrypted)`);
      }
    })();
    context.payloads.set(revisionId, payload);
  }
  return payload;
}

async function targetsOf(rolloutId: number): Promise<TargetRow[]> {
  return appDb.select().from(fleetRolloutTargets).where(eq(fleetRolloutTargets.rolloutId, rolloutId)).orderBy(asc(fleetRolloutTargets.id));
}

async function isRunning(rolloutId: number): Promise<boolean> {
  return (await getRolloutRow(rolloutId))?.status === "running";
}

async function updateTarget(id: number, values: Partial<typeof fleetRolloutTargets.$inferInsert>): Promise<void> {
  await appDb.update(fleetRolloutTargets).set(values).where(eq(fleetRolloutTargets.id, id));
}

/** `waiting`: a pull replica has not confirmed the revision yet; the target stays pending. */
type PushResult = { kind: "synced" } | { kind: "failed" | "skipped"; error: string } | { kind: "busy" } | { kind: "waiting" };

/**
 * A rollout's step for a pull replica: ask it to take the revision (the
 * first time), then see whether it confirmed it: it reported the revision's
 * fingerprint since it was asked (recorded as a push, see pull-server.ts),
 * reported it could not apply it, or let the pull timeout pass.
 */
async function requestPullTarget(rollout: RolloutRow, target: TargetRow, instance: InstanceRow, context: TickContext): Promise<PushResult> {
  if (!target.requestedAt) {
    // The master's clock, like the confirmation it is compared with.
    await updateTarget(target.id, { requestedAt: nowIso() });
    return { kind: "waiting" };
  }
  const requestedAt = target.requestedAt;
  const [fleet] = await appDb
    .select({ revisionId: fleetInstances.revisionId, pushedAt: fleetInstances.pushedAt })
    .from(fleetInstances)
    .where(eq(fleetInstances.instanceId, instance.id))
    .limit(1);
  if (fleet?.revisionId === rollout.revisionId && fleet.pushedAt && fleet.pushedAt >= requestedAt) {
    await updateTarget(target.id, { status: "synced", error: null, syncedAt: fleet.pushedAt });
    return { kind: "synced" };
  }
  const pull = await getPullReplicaRow(instance.id);
  if (
    instance.lastSyncError &&
    instance.lastSyncAt &&
    instance.lastSyncAt >= requestedAt &&
    pull?.deliveredRevisionId === rollout.revisionId &&
    pull.deliveredAt &&
    pull.deliveredAt >= requestedAt
  ) {
    const error = `The pull replica could not apply the revision: ${instance.lastSyncError}`;
    await updateTarget(target.id, { status: "failed", error });
    return { kind: "failed", error };
  }
  const timeoutMs = pullApplyTimeoutMs(pull?.pollIntervalSeconds ?? null);
  if (context.now.getTime() - Date.parse(requestedAt) >= timeoutMs) {
    const error =
      pull?.deliveredRevisionId === rollout.revisionId && pull.deliveredAt && pull.deliveredAt >= requestedAt
        ? `The pull replica took the revision but did not confirm it within ${Math.round(timeoutMs / 1000)} s`
        : `The pull replica did not fetch the revision within ${Math.round(timeoutMs / 1000)} s (it has not checked in)`;
    await updateTarget(target.id, { status: "failed", error });
    return { kind: "failed", error };
  }
  return { kind: "waiting" };
}

/** Push the rollout's revision to one target and record the outcome on it. */
async function pushTarget(rollout: RolloutRow, target: TargetRow, context: TickContext): Promise<PushResult> {
  const instance = await getInstanceRow(target.instanceId);
  if (!instance || !instance.enabled) {
    const error = instance ? "The instance is disabled" : "The instance was deleted";
    await updateTarget(target.id, { status: "skipped", error });
    return { kind: "skipped", error };
  }
  if (instance.syncMode === "pull") return requestPullTarget(rollout, target, instance, context);
  const pushed = await tryWithClusterLock(fleetPushLockName(instance.id), async (): Promise<InstanceSyncOutcome | PushResult> => {
    let payload: SyncPayload;
    try {
      payload = await revisionPayload(context, rollout.revisionId);
    } catch (error) {
      const message = error instanceof RevisionUnavailableError ? error.message : "The revision could not be prepared for sync";
      await updateTarget(target.id, { status: "failed", error: message });
      return { kind: "failed", error: message };
    }
    return await syncInstanceWithPayload(instance, payload, { revisionId: rollout.revisionId });
  });
  if (!pushed.acquired) return { kind: "busy" };
  if ("kind" in pushed.value) return pushed.value;
  const outcome = pushed.value;
  if (outcome.ok) {
    await updateTarget(target.id, { status: "synced", error: null, syncedAt: nowIso() });
    return { kind: "synced" };
  }
  await updateTarget(target.id, { status: "failed", error: outcome.error });
  return { kind: "failed", error: outcome.error };
}

/**
 * Health checks of a pull replica canary, from its reports: it must keep
 * checking in and report itself healthy and, with the Caddy status check,
 * report Caddy's last apply as successful, the promoted revision's
 * fingerprint and no local changes.
 */
async function checkPullCanary(instance: InstanceRow, rollout: RolloutRow, now: Date): Promise<{ ok: true } | { ok: false; error: string }> {
  const pull = await getPullReplicaRow(instance.id);
  if (checkInState(pull, now) !== "ok") return { ok: false, error: "The pull replica stopped checking in" };
  const report = readPullReport(pull);
  if (!report) return { ok: false, error: "The pull replica sent no valid status report" };
  if (!report.healthy) return { ok: false, error: "The pull replica did not report itself healthy" };
  if (!rollout.checkCaddyStatus) return { ok: true };
  const status = report.status;
  if (status.caddy && !status.caddy.ok) {
    return { ok: false, error: `Caddy did not apply the configuration on the instance${status.caddy.code ? ` (${status.caddy.code})` : ""}` };
  }
  const [row] = await appDb
    .select({ fingerprint: fleetInstances.pushedFingerprint })
    .from(fleetInstances)
    .where(eq(fleetInstances.instanceId, instance.id))
    .limit(1);
  if (row?.fingerprint && status.fingerprint !== row.fingerprint) {
    return { ok: false, error: "The instance no longer runs the promoted revision" };
  }
  if (status.localChanges === true) return { ok: false, error: "The instance's configuration was changed on the instance itself" };
  return { ok: true };
}

/** Health checks of the canary while it is observed. */
async function checkCanary(instance: InstanceRow, rollout: RolloutRow, now: Date): Promise<{ ok: true } | { ok: false; error: string }> {
  if (instance.syncMode === "pull") return checkPullCanary(instance, rollout, now);
  const health = await fetchInstanceHealth(instance);
  if (!health.ok) return health;
  if (!rollout.checkCaddyStatus) return { ok: true };
  const reply = await fetchInstanceSyncStatus(instance);
  if (!reply.reachable) return { ok: false, error: reply.error };
  if (!reply.status) {
    return { ok: false, error: "The instance runs an older release that cannot report its Caddy status (turn the Caddy status check off for it)" };
  }
  const status = reply.status;
  if (status.caddy && !status.caddy.ok) {
    return { ok: false, error: `Caddy did not apply the configuration on the instance${status.caddy.code ? ` (${status.caddy.code})` : ""}` };
  }
  const [row] = await appDb
    .select({ fingerprint: fleetInstances.pushedFingerprint })
    .from(fleetInstances)
    .where(eq(fleetInstances.instanceId, instance.id))
    .limit(1);
  if (row?.fingerprint && status.fingerprint !== row.fingerprint) {
    return { ok: false, error: "The instance no longer runs the promoted revision" };
  }
  if (status.localChanges === true) return { ok: false, error: "The instance's configuration was changed on the instance itself" };
  return { ok: true };
}

function listNames(names: string[]): string {
  const shown = names.slice(0, MAX_LISTED_NAMES).map((name) => `"${name}"`).join(", ");
  return names.length > MAX_LISTED_NAMES ? `${shown} and ${names.length - MAX_LISTED_NAMES} more` : shown;
}

/**
 * End a running rollout. A success pins the environment to the revision; a
 * failure leaves the environment and every instance not pushed yet where
 * they were. Recorded in the audit log (by the system).
 */
async function finishRollout(rollout: RolloutRow, status: "succeeded" | "failed", error: string | null): Promise<void> {
  const now = nowIso();
  const finished = await appDb.transaction(async (tx) => {
    const updated = await tx
      .update(fleetRollouts)
      .set({ status, phase: "done", error, updatedAt: now, finishedAt: now })
      .where(and(eq(fleetRollouts.id, rollout.id), eq(fleetRollouts.status, "running")))
      .returning({ id: fleetRollouts.id });
    if (updated.length === 0) return false;
    await tx.update(fleetRolloutTargets)
      .set({ status: "skipped", error: "Not pushed: the rollout failed" })
      .where(and(eq(fleetRolloutTargets.rolloutId, rollout.id), eq(fleetRolloutTargets.status, "pending")));
    if (status === "succeeded") {
      await tx.update(fleetEnvironments)
        .set({ revisionId: rollout.revisionId, updatedAt: now })
        .where(eq(fleetEnvironments.id, rollout.environmentId));
    }
    return true;
  });
  if (!finished) return;
  const environment = await getEnvironmentRow(rollout.environmentId);
  const name = environment?.name ?? String(rollout.environmentId);
  await logAuditEvent({
    action: status === "succeeded" ? "fleet_rollout_succeeded" : "fleet_rollout_failed",
    entityType: "fleet_rollout",
    entityId: rollout.id,
    summary:
      status === "succeeded"
        ? `Rolled revision #${rollout.revisionId} out to fleet environment "${name}"`
        : `Rollout #${rollout.id} of revision #${rollout.revisionId} to fleet environment "${name}" failed: ${error}`,
    data: { environmentId: rollout.environmentId, revisionId: rollout.revisionId, error },
  });
  await pruneFleetHistory().catch(() => undefined);
}

/** Moves a rollout on by one step. True when the next step can follow at once. */
async function stepRollout(rollout: RolloutRow, context: TickContext): Promise<boolean> {
  const targets = await targetsOf(rollout.id);
  const canary = targets.find((target) => target.role === "canary");

  if (rollout.phase === "canary") {
    if (!canary) {
      await finishRollout(rollout, "failed", "The rollout has no canary instance");
      return false;
    }
    if (canary.status === "pending") {
      const result = await pushTarget(rollout, canary, context);
      if (result.kind === "busy" || result.kind === "waiting" || !(await isRunning(rollout.id))) return false;
      if (result.kind !== "synced") {
        await finishRollout(rollout, "failed", `The canary "${canary.instanceName}" was not synced: ${result.error}`);
        return false;
      }
    } else if (canary.status !== "synced") {
      await finishRollout(rollout, "failed", `The canary "${canary.instanceName}" was not synced: ${canary.error ?? "unknown error"}`);
      return false;
    }
    const observeUntil = new Date(context.now.getTime() + rollout.canaryWaitSeconds * 1000).toISOString();
    await appDb
      .update(fleetRollouts)
      .set({ phase: "observing", observeUntil, updatedAt: nowIso() })
      .where(and(eq(fleetRollouts.id, rollout.id), eq(fleetRollouts.status, "running")));
    return true;
  }

  if (rollout.phase === "observing") {
    const instance = canary ? await getInstanceRow(canary.instanceId) : null;
    if (!canary || !instance || !instance.enabled) {
      await finishRollout(rollout, "failed", "The canary instance was deleted or disabled while it was observed");
      return false;
    }
    const check = await checkCanary(instance, rollout, context.now);
    if (!(await isRunning(rollout.id))) return false;
    if (!check.ok) {
      await finishRollout(rollout, "failed", `Canary "${canary.instanceName}" failed its health check: ${check.error}`);
      return false;
    }
    const due = !rollout.observeUntil || Date.parse(rollout.observeUntil) <= context.now.getTime();
    await appDb
      .update(fleetRollouts)
      .set({ lastCheckAt: context.now.toISOString(), ...(due ? { phase: "rolling" } : {}), updatedAt: nowIso() })
      .where(and(eq(fleetRollouts.id, rollout.id), eq(fleetRollouts.status, "running")));
    return due;
  }

  if (rollout.phase === "rolling") {
    const pending = targets.filter((target) => target.status === "pending");
    for (let index = 0; index < pending.length; index += PUSH_CONCURRENCY) {
      if (!(await isRunning(rollout.id))) return false;
      await Promise.all(pending.slice(index, index + PUSH_CONCURRENCY).map((target) => pushTarget(rollout, target, context)));
    }
    if (!(await isRunning(rollout.id))) return false;
    const after = await targetsOf(rollout.id);
    // Targets another push to the same instance held up, and pull replicas
    // that have not confirmed the revision yet, are tried next time.
    if (after.some((target) => target.status === "pending")) return false;
    const failed = after.filter((target) => target.status === "failed");
    if (failed.length > 0) {
      const first = failed[0];
      await finishRollout(
        rollout,
        "failed",
        `Sync failed for ${listNames(failed.map((target) => target.instanceName))}` + (first.error ? ` (${first.error})` : "")
      );
    } else {
      await finishRollout(rollout, "succeeded", null);
    }
    return false;
  }

  // A rollout marked running in a finished phase: settle it.
  await finishRollout(rollout, "failed", "The rollout stopped in an unknown state");
  return false;
}

async function advanceRollout(id: number, context: TickContext): Promise<void> {
  // canary -> observing -> rolling can happen in one tick when nothing waits.
  for (let steps = 0; steps < 4; steps++) {
    const rollout = await getRolloutRow(id);
    if (!rollout || rollout.status !== "running") return;
    if (!(await stepRollout(rollout, context))) return;
  }
}

/**
 * One pass of the engine over every running rollout, oldest first. Skipped
 * while another pass is running anywhere in the deployment
 * (FLEET_ROLLOUT_LOCK) and when this instance is not a master.
 */
export async function runRolloutTick(options: { now?: Date } = {}): Promise<{ rollouts: number }> {
  const pass = await tryWithClusterLock(FLEET_ROLLOUT_LOCK, () => runRolloutPass(options));
  return pass.acquired ? pass.value : { rollouts: 0 };
}

async function runRolloutPass(options: { now?: Date }): Promise<{ rollouts: number }> {
  if ((await getInstanceMode()) !== "master") return { rollouts: 0 };
  const running = await appDb
    .select({ id: fleetRollouts.id })
    .from(fleetRollouts)
    .where(eq(fleetRollouts.status, "running"))
    .orderBy(asc(fleetRollouts.id));
  const context: TickContext = { now: options.now ?? new Date(), payloads: new Map() };
  for (const { id } of running) {
    try {
      await advanceRollout(id, context);
    } catch (error) {
      console.error(`[fleet] Rollout ${id} could not advance:`, error instanceof Error ? error.name : typeof error);
    }
  }
  return { rollouts: running.length };
}
