// SPDX-License-Identifier: Elastic-2.0
/**
 * Fleet environments and instance assignments.
 *
 * Permissions: fleet:write manages environments and assignments. Anything
 * that releases instances from promotion (turning promotion-only off, taking
 * an instance out of a promotion-only environment, deleting one that still
 * has instances) also needs fleet:promote: afterwards those instances
 * receive every change at once, which is what a promotion controls.
 */
import { and, eq, inArray, max } from "drizzle-orm";
import { appDb, nowIso, toIso } from "@/src/lib/db";
import { fleetEnvironments, fleetInstances, fleetPullReplicas, fleetRollouts, fleetRolloutTargets, instances } from "@/src/lib/db/schema";
import { ApiClientError, ApiConflictError, ApiValidationError } from "@/src/lib/api-errors";
import { logAuditEvent } from "@/src/lib/audit";
import { can, type Access } from "@/src/lib/permissions";
import { sanitizeInstanceSyncError } from "@/src/lib/instance-sync-error";
import {
  readBoolean,
  readInteger,
  readName,
  rejectUnknownKeys,
  requireObject,
} from "@/ee/alerting/validation";
import { checkInState } from "./pull-replicas";
import {
  DEFAULT_CANARY_WAIT_SECONDS,
  DRIFT_STATUSES,
  MAX_CANARY_WAIT_SECONDS,
  type DriftStatus,
  type EnvironmentView,
  type FleetInstanceView,
} from "./types";
import { asc } from "@/src/lib/db/ops";

export const ENVIRONMENT_NOT_FOUND = "Environment not found";
export const INSTANCE_NOT_FOUND = "Instance not found";

const MAX_DESCRIPTION_LENGTH = 500;
const MAX_POSITION = 10_000;
const ENVIRONMENT_FIELDS = ["name", "description", "position", "promotionOnly", "canary"];
const CANARY_FIELDS = ["enabled", "waitSeconds", "checkCaddyStatus"];

export type EnvironmentRow = typeof fleetEnvironments.$inferSelect;
type InstanceRow = typeof instances.$inferSelect;

/** A permission refusal that is not the route guard's (its message names what is missing). */
export class FleetPermissionError extends ApiClientError {
  constructor(message: string) {
    super(message, 403);
    this.name = "FleetPermissionError";
  }
}

function assertMayRelease(access: Access, what: string): void {
  if (!can(access, "fleet:promote")) {
    throw new FleetPermissionError(
      `${what} needs the fleet:promote permission as well: the instances then receive every change at once`
    );
  }
}

// ── Reading ─────────────────────────────────────────────────────────────

export async function getEnvironmentRow(id: number): Promise<EnvironmentRow | null> {
  const [row] = await appDb.select().from(fleetEnvironments).where(eq(fleetEnvironments.id, id)).limit(1);
  return row ?? null;
}

export async function requireEnvironmentRow(id: number): Promise<EnvironmentRow> {
  const row = await getEnvironmentRow(id);
  if (!row) throw new ApiClientError(ENVIRONMENT_NOT_FOUND, 404);
  return row;
}

/** Every environment, in promotion order (position, then id). */
export async function listEnvironmentRows(): Promise<EnvironmentRow[]> {
  return appDb.select().from(fleetEnvironments).orderBy(asc(fleetEnvironments.position), asc(fleetEnvironments.id));
}

/** The running rollout into environment `id`, if any. */
export async function getRunningRolloutId(environmentId: number): Promise<number | null> {
  const [row] = await appDb
    .select({ id: fleetRollouts.id })
    .from(fleetRollouts)
    .where(and(eq(fleetRollouts.environmentId, environmentId), eq(fleetRollouts.status, "running")))
    .limit(1);
  return row?.id ?? null;
}

async function assertNoRunningRollout(environment: EnvironmentRow): Promise<void> {
  if ((await getRunningRolloutId(environment.id)) !== null) {
    throw new ApiConflictError(`A rollout is running in environment "${environment.name}"; wait for it or abort it first`);
  }
}

async function instanceIdsByEnvironment(): Promise<Map<number, number[]>> {
  const rows = await appDb
    .select({ instanceId: fleetInstances.instanceId, environmentId: fleetInstances.environmentId })
    .from(fleetInstances)
    .innerJoin(instances, eq(instances.id, fleetInstances.instanceId))
    .orderBy(asc(instances.name), asc(instances.id));
  const map = new Map<number, number[]>();
  for (const row of rows) {
    if (row.environmentId === null) continue;
    map.set(row.environmentId, [...(map.get(row.environmentId) ?? []), row.instanceId]);
  }
  return map;
}

function toEnvironmentView(row: EnvironmentRow, instanceIds: number[], activeRolloutId: number | null): EnvironmentView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    position: row.position,
    promotionOnly: row.promotionOnly,
    revisionId: row.promotionOnly ? row.revisionId : null,
    canary: { enabled: row.canaryEnabled, waitSeconds: row.canaryWaitSeconds, checkCaddyStatus: row.checkCaddyStatus },
    instanceIds,
    activeRolloutId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listEnvironments(): Promise<EnvironmentView[]> {
  const [rows, byEnvironment, running] = await Promise.all([
    listEnvironmentRows(),
    instanceIdsByEnvironment(),
    appDb.select({ id: fleetRollouts.id, environmentId: fleetRollouts.environmentId }).from(fleetRollouts).where(eq(fleetRollouts.status, "running")),
  ]);
  const runningByEnvironment = new Map(running.map((row) => [row.environmentId, row.id]));
  return rows.map((row) => toEnvironmentView(row, byEnvironment.get(row.id) ?? [], runningByEnvironment.get(row.id) ?? null));
}

export async function getEnvironment(id: number): Promise<EnvironmentView> {
  const row = await requireEnvironmentRow(id);
  const [byEnvironment, activeRolloutId] = await Promise.all([instanceIdsByEnvironment(), getRunningRolloutId(id)]);
  return toEnvironmentView(row, byEnvironment.get(id) ?? [], activeRolloutId);
}

function readDriftStatus(value: string | null): DriftStatus | null {
  return value !== null && (DRIFT_STATUSES as readonly string[]).includes(value) ? (value as DriftStatus) : null;
}

/** Every instance configured in the database, with its environment, what it last received and its drift. */
export async function listFleetInstances(): Promise<FleetInstanceView[]> {
  const rows = await appDb
    .select({ instance: instances, fleet: fleetInstances, pull: fleetPullReplicas })
    .from(instances)
    .leftJoin(fleetInstances, eq(fleetInstances.instanceId, instances.id))
    .leftJoin(fleetPullReplicas, eq(fleetPullReplicas.instanceId, instances.id))
    .orderBy(asc(instances.name), asc(instances.id));
  const now = new Date();
  return rows.map(({ instance, fleet, pull }) => ({
    id: instance.id,
    name: instance.name,
    baseUrl: instance.baseUrl,
    syncMode: instance.syncMode === "pull" ? "pull" : "push",
    pull:
      instance.syncMode === "pull"
        ? {
          lastSeenAt: pull?.lastSeenAt ?? null,
          pollIntervalSeconds: pull?.pollIntervalSeconds ?? null,
          checkIn: checkInState(pull, now),
          hasCredential: Boolean(pull?.credentialHash),
        }
        : null,
    enabled: instance.enabled,
    environmentId: fleet?.environmentId ?? null,
    revisionId: fleet?.revisionId ?? null,
    pushedAt: fleet?.pushedAt ?? null,
    lastSyncAt: instance.lastSyncAt ? toIso(instance.lastSyncAt) : null,
    lastSyncError: sanitizeInstanceSyncError(instance.lastSyncError),
    drift: {
      status: readDriftStatus(fleet?.driftStatus ?? null),
      checkedAt: fleet?.driftCheckedAt ?? null,
      since: fleet?.driftSince ?? null,
      detail: fleet?.driftDetail ?? null,
      reportedVersion: fleet?.reportedVersion ?? null,
      localChanges: fleet?.localChanges ?? null,
    },
  }));
}

export async function getInstanceRow(id: number): Promise<InstanceRow | null> {
  const [row] = await appDb.select().from(instances).where(eq(instances.id, id)).limit(1);
  return row ?? null;
}

export async function getInstanceEnvironmentId(instanceId: number): Promise<number | null> {
  const [row] = await appDb
    .select({ environmentId: fleetInstances.environmentId })
    .from(fleetInstances)
    .where(eq(fleetInstances.instanceId, instanceId))
    .limit(1);
  return row?.environmentId ?? null;
}

async function countInstancesIn(environmentId: number): Promise<number> {
  return (await instanceIdsByEnvironment()).get(environmentId)?.length ?? 0;
}

// ── Input ───────────────────────────────────────────────────────────────

type EnvironmentChanges = {
  name?: string;
  description?: string | null;
  position?: number;
  promotionOnly?: boolean;
  canaryEnabled?: boolean;
  canaryWaitSeconds?: number;
  checkCaddyStatus?: boolean;
};

function readDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ApiValidationError("description must be a string");
  const trimmed = value.trim();
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    throw new ApiValidationError(`description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  if (/\p{Cc}/u.test(trimmed.replace(/[\n\t]/g, ""))) {
    throw new ApiValidationError("description must not contain control characters");
  }
  return trimmed || null;
}

function readEnvironmentChanges(input: unknown): EnvironmentChanges {
  const body = requireObject(input, "Body");
  rejectUnknownKeys(body, ENVIRONMENT_FIELDS, "the environment");
  const changes: EnvironmentChanges = {};
  if (body.name !== undefined) changes.name = readName(body.name);
  if (body.description !== undefined) changes.description = readDescription(body.description);
  if (body.position !== undefined) changes.position = readInteger(body.position, "position", 0, MAX_POSITION);
  if (body.promotionOnly !== undefined) changes.promotionOnly = readBoolean(body.promotionOnly, "promotionOnly", false);
  if (body.canary !== undefined) {
    const canary = requireObject(body.canary, "canary");
    rejectUnknownKeys(canary, CANARY_FIELDS, "canary");
    if (canary.enabled !== undefined) changes.canaryEnabled = readBoolean(canary.enabled, "canary.enabled", true);
    if (canary.waitSeconds !== undefined) {
      changes.canaryWaitSeconds = readInteger(canary.waitSeconds, "canary.waitSeconds", 0, MAX_CANARY_WAIT_SECONDS);
    }
    if (canary.checkCaddyStatus !== undefined) {
      changes.checkCaddyStatus = readBoolean(canary.checkCaddyStatus, "canary.checkCaddyStatus", true);
    }
  }
  return changes;
}

async function assertNameFree(name: string, exceptId?: number): Promise<void> {
  const [row] = await appDb.select({ id: fleetEnvironments.id }).from(fleetEnvironments).where(eq(fleetEnvironments.name, name)).limit(1);
  if (row && row.id !== exceptId) throw new ApiConflictError(`An environment named "${name}" already exists`);
}

// ── Changes ─────────────────────────────────────────────────────────────

/** Create an environment. */
export async function createEnvironment(input: unknown, userId: number): Promise<EnvironmentView> {
  const changes = readEnvironmentChanges(input);
  if (changes.name === undefined) throw new ApiValidationError("name is required");
  const name = changes.name;
  const now = nowIso();
  // The name check, the position and the insert in one transaction.
  const row = await appDb.transaction(async (tx) => {
    await assertNameFree(name);
    let position = changes.position;
    if (position === undefined) {
      const [last] = await tx.select({ value: max(fleetEnvironments.position) }).from(fleetEnvironments);
      position = Math.min((last?.value ?? -1) + 1, MAX_POSITION);
    }
    const [row] = await tx
      .insert(fleetEnvironments)
      .values({
        name,
        description: changes.description ?? null,
        position,
        promotionOnly: changes.promotionOnly ?? false,
        revisionId: null,
        canaryEnabled: changes.canaryEnabled ?? true,
        canaryWaitSeconds: changes.canaryWaitSeconds ?? DEFAULT_CANARY_WAIT_SECONDS,
        checkCaddyStatus: changes.checkCaddyStatus ?? true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return row;
  });
  await logAuditEvent({
    userId,
    action: "fleet_environment_created",
    entityType: "fleet_environment",
    entityId: row.id,
    summary: `Created fleet environment "${row.name}"${row.promotionOnly ? " (promotion only)" : ""}`,
    data: { position: row.position, promotionOnly: row.promotionOnly },
  });
  return getEnvironment(row.id);
}

/**
 * Change an environment; fields left out keep their values. Turning
 * promotion-only off releases the environment's instances: it needs
 * fleet:promote when the environment has instances, is refused while a
 * rollout runs there, and drops the pinned revision. The instances then get
 * the master's configuration with the next change or sync.
 */
export async function updateEnvironment(id: number, input: unknown, actor: { userId: number; access: Access }): Promise<EnvironmentView> {
  const existing = await requireEnvironmentRow(id);
  const changes = readEnvironmentChanges(input);
  if (Object.keys(changes).length === 0) throw new ApiValidationError("Body must change at least one field");
  if (changes.name !== undefined) await assertNameFree(changes.name, id);

  const releasing = existing.promotionOnly && changes.promotionOnly === false;
  const pinning = !existing.promotionOnly && changes.promotionOnly === true;
  if (releasing || pinning) await assertNoRunningRollout(existing);
  if (releasing && (await countInstancesIn(id)) > 0) {
    assertMayRelease(actor.access, `Turning promotion-only off for "${existing.name}"`);
  }

  const [row] = await appDb
    .update(fleetEnvironments)
    .set({
      ...changes,
      ...(releasing ? { revisionId: null } : {}),
      updatedAt: nowIso(),
    })
    .where(eq(fleetEnvironments.id, id))
    .returning();
  await logAuditEvent({
    userId: actor.userId,
    action: "fleet_environment_updated",
    entityType: "fleet_environment",
    entityId: id,
    summary: releasing
      ? `Turned promotion-only off for fleet environment "${row.name}"`
      : pinning
        ? `Turned promotion-only on for fleet environment "${row.name}"`
        : `Updated fleet environment "${row.name}"`,
    data: { changes, previousRevisionId: releasing ? existing.revisionId : undefined },
  });
  return getEnvironment(id);
}

/**
 * Delete an environment. Its instances lose their environment (and receive
 * every change again: fleet:promote when it was promotion-only); its
 * rollouts are deleted with it. Refused while a rollout runs there.
 */
export async function deleteEnvironment(id: number, actor: { userId: number; access: Access }): Promise<void> {
  const existing = await requireEnvironmentRow(id);
  await assertNoRunningRollout(existing);
  const instanceCount = await countInstancesIn(id);
  if (existing.promotionOnly && instanceCount > 0) {
    assertMayRelease(actor.access, `Deleting the promotion-only environment "${existing.name}" with instances`);
  }
  const rolloutIds = (await appDb.select({ id: fleetRollouts.id }).from(fleetRollouts).where(eq(fleetRollouts.environmentId, id))).map((row) => row.id);
  await appDb.transaction(async (tx) => {
    await tx.update(fleetInstances).set({ environmentId: null, updatedAt: nowIso() }).where(eq(fleetInstances.environmentId, id));
    if (rolloutIds.length > 0) {
      await tx.delete(fleetRolloutTargets).where(inArray(fleetRolloutTargets.rolloutId, rolloutIds));
      await tx.delete(fleetRollouts).where(inArray(fleetRollouts.id, rolloutIds));
    }
    await tx.delete(fleetEnvironments).where(eq(fleetEnvironments.id, id));
  });
  await logAuditEvent({
    userId: actor.userId,
    action: "fleet_environment_deleted",
    entityType: "fleet_environment",
    entityId: id,
    summary: `Deleted fleet environment "${existing.name}"${instanceCount > 0 ? ` (${instanceCount} instance(s) left without environment)` : ""}`,
    data: { promotionOnly: existing.promotionOnly, revisionId: existing.revisionId, instances: instanceCount },
  });
}

/**
 * Put instance `instanceId` in environment `environmentId`, or take it out
 * (null). Leaving a promotion-only environment for none or for one that
 * receives every change needs fleet:promote. Refused while a rollout runs in
 * either environment. Nothing is pushed: an instance that joins a
 * promotion-only environment keeps its configuration until the next
 * promotion or re-sync, and one that leaves it gets the master's with the
 * next change or sync.
 */
export async function assignInstance(
  instanceId: number,
  input: unknown,
  actor: { userId: number; access: Access }
): Promise<FleetInstanceView> {
  const body = requireObject(input, "Body");
  rejectUnknownKeys(body, ["environmentId"], "the assignment");
  if (!("environmentId" in body)) throw new ApiValidationError("environmentId is required (null takes the instance out of its environment)");
  const raw = body.environmentId;
  if (raw !== null && (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1)) {
    throw new ApiValidationError("environmentId must be an environment id or null");
  }
  const targetId = raw as number | null;

  const instance = await getInstanceRow(instanceId);
  if (!instance) throw new ApiClientError(INSTANCE_NOT_FOUND, 404);
  const target = targetId === null ? null : await requireEnvironmentRow(targetId);
  const currentId = await getInstanceEnvironmentId(instanceId);
  const current = currentId === null ? null : await getEnvironmentRow(currentId);

  if (current?.id !== target?.id) {
    if (current) await assertNoRunningRollout(current);
    if (target) await assertNoRunningRollout(target);
    if (current?.promotionOnly && !target?.promotionOnly) {
      assertMayRelease(actor.access, `Taking "${instance.name}" out of the promotion-only environment "${current.name}"`);
    }
    const now = nowIso();
    await appDb
      .insert(fleetInstances)
      .values({ instanceId, environmentId: target?.id ?? null, updatedAt: now })
      .onConflictDoUpdate({ target: fleetInstances.instanceId, set: { environmentId: target?.id ?? null, updatedAt: now } });
    await logAuditEvent({
      userId: actor.userId,
      action: "fleet_instance_assigned",
      entityType: "instance",
      entityId: instanceId,
      summary: target
        ? `Moved instance "${instance.name}" to fleet environment "${target.name}"`
        : `Took instance "${instance.name}" out of fleet environment "${current?.name ?? "?"}"`,
      data: { fromEnvironmentId: current?.id ?? null, toEnvironmentId: target?.id ?? null },
    });
  }
  const view = (await listFleetInstances()).find((item) => item.id === instanceId);
  if (!view) throw new ApiClientError(INSTANCE_NOT_FOUND, 404);
  return view;
}
