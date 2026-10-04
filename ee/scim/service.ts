// SPDX-License-Identifier: Elastic-2.0
/**
 * SCIM provisioning: the administrator actions, shared by the REST API and
 * the dashboard.
 *
 * License (feature "scim"): turning SCIM on, changing its settings, creating
 * tokens (tokens.ts), adding or changing group-to-role mappings and handing
 * users or groups to SCIM need it. Turning SCIM off, revoking tokens,
 * deleting mappings and releasing users or groups never do. A mapping to a
 * custom role also needs "custom_roles", as assigning one does.
 *
 * Mappings are role grants: an actor may only map a role they could assign
 * themselves (assertCanGrant, ee/custom-roles/escalation.ts).
 */
import { and, count, eq, isNull, ne } from "drizzle-orm";
import { appDb, nowIso, toIso } from "@/src/lib/db";
import {
  customRoles,
  groupMembers,
  groups,
  oauthProviders,
  samlProviders,
  scimGroupMembers,
  scimGroups,
  scimRoleMappings,
  scimTokens,
  scimUsers,
  users,
} from "@/src/lib/db/schema";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import { isBuiltInRole, type Access } from "@/src/lib/permissions";
import { isFeatureConfigurable, requireFeature } from "@/ee/licensing/store";
import { assertCanGrant, grantOfBuiltInRole, grantOfRole } from "@/ee/custom-roles/escalation";
import { readCustomRole, FEATURE as CUSTOM_ROLES_FEATURE } from "@/ee/custom-roles/store";
import { assertCanManageUserId } from "@/ee/custom-roles/service";
import { parseSamlProviderId, samlProviderId } from "@/ee/saml/constants";
import type { ScimAuditEvent } from "./audit";
import { scimEndpointUrl } from "./protocol";
import { syncAllUserRoles } from "./role-sync";
import { isProtectedUser, readScimSettings, userNameKey, writeScimSettings, type ScimWriter } from "./store";
import {
  FEATURE,
  SCIM_DEFAULT_ROLES,
  SCIM_DELETE_MODES,
  type ScimManagedGroupView,
  type ScimManagedUserView,
  type ScimRoleMappingView,
  type ScimSettings,
  type ScimSettingsView,
} from "./types";
import { asc, first } from "@/src/lib/db/ops";
import { isRowId } from "@/src/lib/row-ids";

const SETTINGS_KEYS = [
  "enabled",
  "providerId",
  "deleteMode",
  "defaultRole",
  "manageRoles",
  "requireVerifiedEmail",
  "externalIdClaim",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) throw new ApiValidationError("Request body must be a JSON object");
  return input;
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new ApiValidationError(`Unknown field "${key.slice(0, 64)}"`);
  }
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new ApiValidationError(`${field} must be true or false`);
  return value;
}

function parseId(value: unknown, field: string): number {
  if (!isRowId(value)) {
    throw new ApiValidationError(`${field} must be an id`);
  }
  return value;
}

/** Logs the role changes a settings or mapping change made, as the actor's. */
async function auditRoleSync(actorUserId: number, events: readonly ScimAuditEvent[], cause: string): Promise<void> {
  for (const event of events) {
    await logAuditEvent({
      userId: actorUserId,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      summary: `SCIM ${cause}: ${event.summary}`,
      data: { source: "scim", cause, ...(event.data ?? {}) },
    });
  }
}

// ── Settings ────────────────────────────────────────────────────────────

/**
 * The providers SCIM users can sign in with: OAuth/OIDC providers, and SAML
 * providers (ee/saml) as "saml:<id>", whose first sign-in links the same way
 * (the SAML attributes take the place of the claims).
 */
async function listSignInProviders(): Promise<ScimSettingsView["providers"]> {
  const oauth = await appDb
    .select({ id: oauthProviders.id, name: oauthProviders.name, enabled: oauthProviders.enabled, autoLink: oauthProviders.autoLink })
    .from(oauthProviders)
    .orderBy(asc(oauthProviders.name), asc(oauthProviders.id));
  const saml = (await appDb
    .select({ id: samlProviders.id, name: samlProviders.name, enabled: samlProviders.enabled, autoLink: samlProviders.linkExistingAccounts })
    .from(samlProviders)
    .orderBy(asc(samlProviders.name), asc(samlProviders.id)))
    .map((row) => ({ ...row, id: samlProviderId(row.id), name: `${row.name} (SAML)` }));
  return [...oauth, ...saml];
}

async function signInProviderExists(providerId: string): Promise<boolean> {
  const samlId = parseSamlProviderId(providerId);
  if (samlId !== null) {
    return !!await first(appDb.select({ id: samlProviders.id }).from(samlProviders).where(eq(samlProviders.id, samlId)).limit(1));
  }
  return !!await first(appDb.select({ id: oauthProviders.id }).from(oauthProviders).where(eq(oauthProviders.id, providerId)).limit(1));
}

export async function getScimSettingsView(): Promise<ScimSettingsView> {
  const settings = await readScimSettings(appDb);
  const providers = await listSignInProviders();
  const countOf = (rows: { value: number }[]) => rows[0]?.value ?? 0;
  return {
    ...settings,
    endpointUrl: scimEndpointUrl(),
    configurable: await isFeatureConfigurable(FEATURE),
    providers,
    counts: {
      users: countOf(await appDb.select({ value: count() }).from(scimUsers).where(isNull(scimUsers.deletedAt))),
      groups: countOf(await appDb.select({ value: count() }).from(scimGroups)),
      tokens: countOf(await appDb.select({ value: count() }).from(scimTokens)),
      mappings: countOf(await appDb.select({ value: count() }).from(scimRoleMappings)),
    },
  };
}

async function readSettingsChange(input: unknown, current: ScimSettings): Promise<ScimSettings> {
  const body = requireRecord(input);
  rejectUnknownKeys(body, SETTINGS_KEYS);
  const next: ScimSettings = { ...current };
  if (body.enabled !== undefined) next.enabled = readBoolean(body.enabled, "enabled");
  if (body.manageRoles !== undefined) next.manageRoles = readBoolean(body.manageRoles, "manageRoles");
  if (body.requireVerifiedEmail !== undefined) {
    next.requireVerifiedEmail = readBoolean(body.requireVerifiedEmail, "requireVerifiedEmail");
  }
  if (body.deleteMode !== undefined) {
    if (!(SCIM_DELETE_MODES as readonly unknown[]).includes(body.deleteMode)) {
      throw new ApiValidationError(`deleteMode must be one of: ${SCIM_DELETE_MODES.join(", ")}`);
    }
    next.deleteMode = body.deleteMode as ScimSettings["deleteMode"];
  }
  if (body.defaultRole !== undefined) {
    if (!(SCIM_DEFAULT_ROLES as readonly unknown[]).includes(body.defaultRole)) {
      throw new ApiValidationError(`defaultRole must be one of: ${SCIM_DEFAULT_ROLES.join(", ")}`);
    }
    next.defaultRole = body.defaultRole as ScimSettings["defaultRole"];
  }
  if (body.providerId !== undefined) {
    if (body.providerId === null || body.providerId === "") {
      next.providerId = null;
    } else {
      if (typeof body.providerId !== "string") throw new ApiValidationError("providerId must be a provider id or null");
      if (!await signInProviderExists(body.providerId)) throw new ApiValidationError("Unknown OAuth/OIDC or SAML provider");
      next.providerId = body.providerId;
    }
  }
  if (body.externalIdClaim !== undefined) {
    if (body.externalIdClaim === null || body.externalIdClaim === "") {
      next.externalIdClaim = null;
    } else {
      if (typeof body.externalIdClaim !== "string" || !/^[A-Za-z0-9_.:/-]{1,64}$/.test(body.externalIdClaim)) {
        throw new ApiValidationError("externalIdClaim must be a claim name (letters, digits and _ . : / -, at most 64)");
      }
      next.externalIdClaim = body.externalIdClaim;
    }
  }
  return next;
}

/** Only turning SCIM off: the one change that never needs a license. */
function isTurnOffOnly(input: unknown): boolean {
  return isRecord(input) && Object.keys(input).length > 0 &&
    Object.entries(input).every(([key, value]) => key === "enabled" && value === false);
}

export async function updateScimSettings(input: unknown, actorUserId: number): Promise<ScimSettingsView> {
  if (!isTurnOffOnly(input)) await requireFeature(FEATURE);
  const { before, after, events } = await appDb.transaction(async (tx) => {
    const before = await readScimSettings(tx);
    const after = await readSettingsChange(input, before);
    await writeScimSettings(tx, after);
    const rolesChanged = after.manageRoles && (!before.manageRoles || before.defaultRole !== after.defaultRole);
    return { before, after, events: rolesChanged ? await syncAllUserRoles(tx, after) : [] };
  });
  const fields = SETTINGS_KEYS.filter((key) => before[key] !== after[key]);
  if (fields.length > 0) {
    await logAuditEvent({
      userId: actorUserId,
      action: "update",
      entityType: "scim_settings",
      entityId: null,
      summary: `Updated SCIM settings: ${fields.join(", ")}`,
      data: { before: Object.fromEntries(fields.map((key) => [key, before[key]])), after: Object.fromEntries(fields.map((key) => [key, after[key]])) },
    });
  }
  await auditRoleSync(actorUserId, events, "settings change");
  return getScimSettingsView();
}

// ── Group-to-role mappings ──────────────────────────────────────────────

export async function listRoleMappings(): Promise<ScimRoleMappingView[]> {
  const rows = await appDb
    .select({ mapping: scimRoleMappings, groupName: groups.name, customRoleName: customRoles.name })
    .from(scimRoleMappings)
    .innerJoin(groups, eq(groups.id, scimRoleMappings.groupId))
    .leftJoin(customRoles, eq(customRoles.id, scimRoleMappings.customRoleId))
    .orderBy(asc(scimRoleMappings.priority), asc(scimRoleMappings.id));
  return rows.map(({ mapping, groupName, customRoleName }) => ({
    id: mapping.id,
    groupId: mapping.groupId,
    groupName,
    role: (isBuiltInRole(mapping.role) ? mapping.role : "viewer") as ScimRoleMappingView["role"],
    customRoleId: mapping.customRoleId ?? null,
    customRoleName: customRoleName ?? null,
    priority: mapping.priority,
    createdAt: toIso(mapping.createdAt)!,
    updatedAt: toIso(mapping.updatedAt)!,
  }));
}

type MappingFields = { groupId: number; role: "admin" | "user" | "viewer"; customRoleId: number | null; priority: number };

function readMappingFields(input: unknown, current: MappingFields | null): MappingFields {
  const body = requireRecord(input);
  rejectUnknownKeys(body, ["groupId", "role", "customRoleId", "priority"]);
  const next: MappingFields = current ? { ...current } : { groupId: 0, role: "user", customRoleId: null, priority: 100 };
  if (body.groupId !== undefined || !current) next.groupId = parseId(body.groupId, "groupId");
  if (body.customRoleId !== undefined && body.customRoleId !== null) {
    next.customRoleId = parseId(body.customRoleId, "customRoleId");
    if (body.role !== undefined && body.role !== null && body.role !== "viewer") {
      throw new ApiValidationError("Send either a built-in role or customRoleId, not both");
    }
    next.role = "viewer";
  } else if (body.role !== undefined || body.customRoleId === null || !current) {
    if (!isBuiltInRole(body.role)) throw new ApiValidationError("role must be one of: admin, user, viewer");
    next.role = body.role;
    next.customRoleId = null;
  }
  if (body.priority !== undefined) {
    if (typeof body.priority !== "number" || !Number.isSafeInteger(body.priority) || body.priority < 0 || body.priority > 10_000) {
      throw new ApiValidationError("priority must be a whole number from 0 to 10000");
    }
    next.priority = body.priority;
  }
  return next;
}

async function checkMappingGrant(actor: Access, fields: MappingFields): Promise<void> {
  if (fields.customRoleId !== null) {
    const role = await readCustomRole(appDb, fields.customRoleId);
    if (!role) throw new ApiValidationError("Unknown custom role");
    await requireFeature(CUSTOM_ROLES_FEATURE);
    assertCanGrant(actor, grantOfRole(role));
  } else {
    assertCanGrant(actor, grantOfBuiltInRole(fields.role));
  }
}

async function assertMappableGroup(tx: ScimWriter, groupId: number, exceptMappingId: number | null): Promise<void> {
  const managed = await first(tx.select({ id: scimGroups.id }).from(scimGroups).where(eq(scimGroups.groupId, groupId)).limit(1));
  if (!managed) throw new ApiValidationError("Only groups that SCIM manages can be mapped to a role");
  const taken = await first(tx
    .select({ id: scimRoleMappings.id })
    .from(scimRoleMappings)
    .where(exceptMappingId === null
      ? eq(scimRoleMappings.groupId, groupId)
      : and(eq(scimRoleMappings.groupId, groupId), ne(scimRoleMappings.id, exceptMappingId)))
    .limit(1));
  if (taken) throw new ApiClientError("This group already has a role mapping", 409);
}

function describeMapping(fields: MappingFields): string {
  return fields.customRoleId !== null ? `custom role ${fields.customRoleId}` : fields.role;
}

export async function createRoleMapping(actor: Access, input: unknown): Promise<ScimRoleMappingView> {
  await requireFeature(FEATURE);
  const fields = readMappingFields(input, null);
  await checkMappingGrant(actor, fields);
  const now = nowIso();
  const { id, events } = await appDb.transaction(async (tx) => {
    await assertMappableGroup(tx, fields.groupId, null);
    const row = (await first(tx.insert(scimRoleMappings).values({ ...fields, createdAt: now, updatedAt: now }).returning()))!;
    return { id: row.id, events: await syncAllUserRoles(tx, await readScimSettings(tx)) };
  });
  await logAuditEvent({
    userId: actor.userId,
    action: "create",
    entityType: "scim_role_mapping",
    entityId: id,
    summary: `Mapped SCIM group ${fields.groupId} to ${describeMapping(fields)}`,
    data: fields,
  });
  await auditRoleSync(actor.userId, events, "role mapping change");
  return (await listRoleMappings()).find((mapping) => mapping.id === id)!;
}

export async function updateRoleMapping(actor: Access, id: number, input: unknown): Promise<ScimRoleMappingView> {
  const existing = await first(appDb.select().from(scimRoleMappings).where(eq(scimRoleMappings.id, id)).limit(1));
  if (!existing) throw new ApiClientError("Role mapping not found", 404);
  await requireFeature(FEATURE);
  const before: MappingFields = {
    groupId: existing.groupId,
    role: (isBuiltInRole(existing.role) ? existing.role : "viewer") as MappingFields["role"],
    customRoleId: existing.customRoleId ?? null,
    priority: existing.priority,
  };
  const fields = readMappingFields(input, before);
  await checkMappingGrant(actor, fields);
  const events = await appDb.transaction(async (tx) => {
    await assertMappableGroup(tx, fields.groupId, id);
    await tx.update(scimRoleMappings).set({ ...fields, updatedAt: nowIso() }).where(eq(scimRoleMappings.id, id));
    return await syncAllUserRoles(tx, await readScimSettings(tx));
  });
  await logAuditEvent({
    userId: actor.userId,
    action: "update",
    entityType: "scim_role_mapping",
    entityId: id,
    summary: `Changed SCIM role mapping ${id}: group ${fields.groupId} to ${describeMapping(fields)}`,
    data: { before, after: fields },
  });
  await auditRoleSync(actor.userId, events, "role mapping change");
  return (await listRoleMappings()).find((mapping) => mapping.id === id)!;
}

/** Deletes a mapping (never needs a license); with managed roles its users get their next mapping or the default role. */
export async function deleteRoleMapping(actor: Access, id: number): Promise<void> {
  const existing = await first(appDb.select().from(scimRoleMappings).where(eq(scimRoleMappings.id, id)).limit(1));
  if (!existing) throw new ApiClientError("Role mapping not found", 404);
  const events = await appDb.transaction(async (tx) => {
    await tx.delete(scimRoleMappings).where(eq(scimRoleMappings.id, id));
    return await syncAllUserRoles(tx, await readScimSettings(tx));
  });
  await logAuditEvent({
    userId: actor.userId,
    action: "delete",
    entityType: "scim_role_mapping",
    entityId: id,
    summary: `Deleted SCIM role mapping ${id} (group ${existing.groupId})`,
    data: { groupId: existing.groupId, role: existing.role, customRoleId: existing.customRoleId },
  });
  await auditRoleSync(actor.userId, events, "role mapping change");
}

// ── Users and groups SCIM manages ───────────────────────────────────────

export async function listManagedUsers(): Promise<ScimManagedUserView[]> {
  const rows = await appDb
    .select({ scim: scimUsers, user: users })
    .from(scimUsers)
    .innerJoin(users, eq(users.id, scimUsers.userId))
    .orderBy(asc(scimUsers.userId));
  return rows.map(({ scim, user }) => ({
    userId: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    role: user.role,
    customRoleId: user.customRoleId ?? null,
    userName: scim.userName,
    externalId: scim.externalId,
    origin: scim.origin === "adopted" ? "adopted" : "scim",
    deletedAt: scim.deletedAt ? toIso(scim.deletedAt) : null,
    linkedAt: scim.linkedAt ? toIso(scim.linkedAt) : null,
    createdAt: toIso(scim.createdAt)!,
    updatedAt: toIso(scim.updatedAt)!,
  }));
}

/**
 * Hands an existing account to SCIM: the identity provider can then find it
 * by `userName` (exactly the value it will send), change it, disable it, and
 * link its first sign-in through the SCIM sign-in provider. This is the only
 * way a local account becomes visible to SCIM. Protected accounts cannot be
 * handed over.
 */
export async function adoptUser(actor: Access, input: unknown): Promise<ScimManagedUserView> {
  const body = requireRecord(input);
  rejectUnknownKeys(body, ["userId", "userName", "externalId"]);
  const userId = parseId(body.userId, "userId");
  if (typeof body.userName !== "string" || !body.userName.trim()) {
    throw new ApiValidationError("userName is required: the exact userName the identity provider sends for this user");
  }
  const userName = body.userName;
  if (userName.length > 256 || /\p{Cc}/u.test(userName)) throw new ApiValidationError("userName is not valid");
  let externalId: string | null = null;
  if (body.externalId !== undefined && body.externalId !== null && body.externalId !== "") {
    if (typeof body.externalId !== "string" || body.externalId.length > 256 || /\p{Cc}/u.test(body.externalId)) {
      throw new ApiValidationError("externalId must be a string of at most 256 characters");
    }
    externalId = body.externalId;
  }
  await requireFeature(FEATURE);
  await assertCanManageUserId(actor, userId);
  const now = nowIso();
  await appDb.transaction(async (tx) => {
    const user = await first(tx.select().from(users).where(eq(users.id, userId)).limit(1));
    if (!user) throw new ApiClientError("User not found", 404);
    if (await isProtectedUser(tx, userId)) {
      throw new ApiValidationError("The primary admin and break-glass accounts cannot be managed by SCIM");
    }
    const existing = await first(tx.select().from(scimUsers).where(eq(scimUsers.userId, userId)).limit(1));
    if (existing && existing.deletedAt === null) throw new ApiClientError("SCIM already manages this user", 409);
    const taken = await first(tx.select({ userId: scimUsers.userId }).from(scimUsers).where(eq(scimUsers.userNameKey, userNameKey(userName))).limit(1));
    if (taken && taken.userId !== userId) throw new ApiClientError("Another SCIM user has this userName", 409);
    const values = {
      userName,
      userNameKey: userNameKey(userName),
      externalId,
      displayName: user.name,
      givenName: null,
      familyName: null,
      formattedName: null,
      emails: JSON.stringify([{ value: user.email, type: "work", primary: true }]),
      active: user.status === "active",
      origin: "adopted",
      deletedAt: null,
      updatedAt: now,
    };
    if (existing) await tx.update(scimUsers).set(values).where(eq(scimUsers.userId, userId));
    else await tx.insert(scimUsers).values({ userId, ...values, createdAt: now });
  });
  await logAuditEvent({
    userId: actor.userId,
    action: "scim_user_adopt",
    entityType: "user",
    entityId: userId,
    summary: `Let SCIM manage user ${userId} as userName ${userName}`,
    data: { userName, externalId },
  });
  return (await listManagedUsers()).find((user) => user.userId === userId)!;
}

/** Stops SCIM managing a user; the account itself is not changed. Never needs a license. */
export async function releaseUser(actor: Access, userId: number): Promise<void> {
  const existing = await first(appDb.select().from(scimUsers).where(eq(scimUsers.userId, userId)).limit(1));
  if (!existing) throw new ApiClientError("SCIM does not manage this user", 404);
  await assertCanManageUserId(actor, userId);
  await appDb.transaction(async (tx) => {
    await tx.delete(scimUsers).where(eq(scimUsers.userId, userId));
    await tx.delete(scimGroupMembers).where(eq(scimGroupMembers.userId, userId));
  });
  await logAuditEvent({
    userId: actor.userId,
    action: "scim_user_release",
    entityType: "user",
    entityId: userId,
    summary: `Stopped SCIM managing user ${userId} (userName ${existing.userName})`,
    data: { userName: existing.userName, origin: existing.origin },
  });
}

export async function listManagedGroups(): Promise<ScimManagedGroupView[]> {
  const rows = await appDb
    .select({ scim: scimGroups, group: groups })
    .from(scimGroups)
    .innerJoin(groups, eq(groups.id, scimGroups.groupId))
    .orderBy(asc(groups.name), asc(groups.id));
  const members = await appDb.select({ groupId: groupMembers.groupId, userId: groupMembers.userId }).from(groupMembers);
  const scimIds = new Set(
    (await appDb.select({ userId: scimUsers.userId }).from(scimUsers).where(isNull(scimUsers.deletedAt))).map((row) => row.userId)
  );
  return rows.map(({ scim, group }) => {
    const groupMembersOf = members.filter((member) => member.groupId === group.id);
    return {
      groupId: group.id,
      name: group.name,
      externalId: scim.externalId,
      origin: scim.origin === "adopted" ? "adopted" : "scim",
      scimMemberCount: groupMembersOf.filter((member) => scimIds.has(member.userId)).length,
      memberCount: groupMembersOf.length,
      createdAt: toIso(scim.createdAt)!,
      updatedAt: toIso(scim.updatedAt)!,
    };
  });
}

/** Hands an existing forward-auth group to SCIM (its other members are left alone). */
export async function adoptGroup(actor: Access, input: unknown): Promise<ScimManagedGroupView> {
  const body = requireRecord(input);
  rejectUnknownKeys(body, ["groupId", "externalId"]);
  const groupId = parseId(body.groupId, "groupId");
  let externalId: string | null = null;
  if (body.externalId !== undefined && body.externalId !== null && body.externalId !== "") {
    if (typeof body.externalId !== "string" || body.externalId.length > 256 || /\p{Cc}/u.test(body.externalId)) {
      throw new ApiValidationError("externalId must be a string of at most 256 characters");
    }
    externalId = body.externalId;
  }
  await requireFeature(FEATURE);
  const now = nowIso();
  const group = await appDb.transaction(async (tx) => {
    const group = await first(tx.select().from(groups).where(eq(groups.id, groupId)).limit(1));
    if (!group) throw new ApiClientError("Group not found", 404);
    const existing = await first(tx.select({ id: scimGroups.id }).from(scimGroups).where(eq(scimGroups.groupId, groupId)).limit(1));
    if (existing) throw new ApiClientError("SCIM already manages this group", 409);
    await tx.insert(scimGroups).values({ groupId, externalId, origin: "adopted", createdAt: now, updatedAt: now });
    return group;
  });
  await logAuditEvent({
    userId: actor.userId,
    action: "scim_group_adopt",
    entityType: "group",
    entityId: groupId,
    summary: `Let SCIM manage group ${groupId} (${group.name})`,
    data: { externalId },
  });
  return (await listManagedGroups()).find((item) => item.groupId === groupId)!;
}

/** Stops SCIM managing a group; members and the group stay. Its role mapping is deleted. Never needs a license. */
export async function releaseGroup(actor: Access, groupId: number): Promise<void> {
  const existing = await first(appDb.select().from(scimGroups).where(eq(scimGroups.groupId, groupId)).limit(1));
  if (!existing) throw new ApiClientError("SCIM does not manage this group", 404);
  const events = await appDb.transaction(async (tx) => {
    await tx.delete(scimRoleMappings).where(eq(scimRoleMappings.groupId, groupId));
    await tx.delete(scimGroupMembers).where(eq(scimGroupMembers.groupId, groupId));
    await tx.delete(scimGroups).where(eq(scimGroups.groupId, groupId));
    return await syncAllUserRoles(tx, await readScimSettings(tx));
  });
  await logAuditEvent({
    userId: actor.userId,
    action: "scim_group_release",
    entityType: "group",
    entityId: groupId,
    summary: `Stopped SCIM managing group ${groupId}`,
    data: { origin: existing.origin },
  });
  await auditRoleSync(actor.userId, events, "group release");
}

/** Whether `userId` is an account SCIM manages (for the Users page). */
export async function scimManagedUserIds(): Promise<Set<number>> {
  return new Set(
    (await appDb.select({ userId: scimUsers.userId }).from(scimUsers).where(isNull(scimUsers.deletedAt))).map((row) => row.userId)
  );
}
