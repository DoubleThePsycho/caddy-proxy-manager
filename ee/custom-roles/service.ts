// SPDX-License-Identifier: Elastic-2.0
/**
 * Custom roles: the administrator actions on roles and on role assignments,
 * shared by the REST API and the dashboard.
 *
 * License (feature "custom_roles"): creating or changing a role and assigning
 * a custom role need it. Deleting a role (its users fall back to the built-in
 * viewer role) and taking a custom role away (assigning a built-in role) never
 * do, and resolving a user's access (access.ts) never looks at it.
 */
import { eq } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { customRoles, scimRoleMappings, users } from "@/src/lib/db/schema";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import { requireFeature } from "@/ee/licensing/store";
import { normalizeTags } from "@/src/lib/host-tags";
import {
  BUILT_IN_ROLES,
  isBuiltInRole,
  normalizePermissions,
  PermissionCatalogueError,
  UNSCOPED_ONLY_PERMISSIONS,
  type Access,
  type BuiltInRole,
  type Permission,
} from "@/src/lib/permissions";
import { setUserRoleAssignment, type User } from "@/src/lib/models/user";
import { accessForUser } from "./access";
import {
  assertActiveAdminRemains,
  assertCanGrant,
  assertCanManageUser,
  assertManagesRoles,
  EscalationError,
  grantOfBuiltInRole,
  grantOfRole,
} from "./escalation";
import {
  FEATURE,
  findCustomRoleByName,
  listCustomRoleViews,
  readCustomRole,
  toRoleView,
  type CustomRole,
  type CustomRoleView,
  type RoleReader,
} from "./store";
import { first } from "@/src/lib/db/ops";

export const MAX_ROLE_NAME_LENGTH = 64;
export const MAX_ROLE_DESCRIPTION_LENGTH = 500;
export const MAX_ROLE_SCOPE_TAGS = 16;

type RoleFields = {
  name: string;
  description: string | null;
  permissions: Permission[];
  scopeTags: string[];
};

const ROLE_KEYS = new Set(["name", "description", "permissions", "scopeTags"]);

function readRoleFields(input: unknown, current: RoleFields | null): RoleFields {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ApiValidationError("Role must be a JSON object");
  }
  const body = input as Record<string, unknown>;
  const unknownKey = Object.keys(body).find((key) => !ROLE_KEYS.has(key));
  if (unknownKey) {
    throw new ApiValidationError(`Unknown role field: ${unknownKey.slice(0, 40)}`);
  }

  let name = current?.name ?? "";
  if (body.name !== undefined || !current) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      throw new ApiValidationError("name is required");
    }
    name = body.name.trim();
    if (name.length > MAX_ROLE_NAME_LENGTH) {
      throw new ApiValidationError(`name must be at most ${MAX_ROLE_NAME_LENGTH} characters`);
    }
    if ((BUILT_IN_ROLES as readonly string[]).includes(name.toLowerCase())) {
      throw new ApiValidationError(`"${name}" is the name of a built-in role`);
    }
  }

  let description = current?.description ?? null;
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== "string") {
      throw new ApiValidationError("description must be a string or null");
    }
    const text = typeof body.description === "string" ? body.description.trim() : "";
    if (text.length > MAX_ROLE_DESCRIPTION_LENGTH) {
      throw new ApiValidationError(`description must be at most ${MAX_ROLE_DESCRIPTION_LENGTH} characters`);
    }
    description = text || null;
  }

  let permissions = current?.permissions ?? [];
  if (body.permissions !== undefined || !current) {
    if (!Array.isArray(body.permissions)) {
      throw new ApiValidationError("permissions must be an array of permission names");
    }
    try {
      permissions = normalizePermissions(body.permissions);
    } catch (error) {
      if (error instanceof PermissionCatalogueError) throw new ApiValidationError(error.message);
      throw error;
    }
  }

  let scopeTags = current?.scopeTags ?? [];
  if (body.scopeTags !== undefined) {
    if (body.scopeTags !== null && !Array.isArray(body.scopeTags)) {
      throw new ApiValidationError("scopeTags must be an array of tags");
    }
    scopeTags = normalizeTags(body.scopeTags ?? []);
    if (scopeTags.length > MAX_ROLE_SCOPE_TAGS) {
      throw new ApiValidationError(`A role can have at most ${MAX_ROLE_SCOPE_TAGS} scope tags`);
    }
  }

  if (scopeTags.length > 0) {
    const unscopable = permissions.filter((permission) => UNSCOPED_ONLY_PERMISSIONS.includes(permission));
    if (unscopable.length > 0) {
      throw new ApiValidationError(
        `A role with a tag scope cannot have ${unscopable.join(", ")}: these act on every host at once`
      );
    }
  }

  return { name, description, permissions, scopeTags };
}

async function assertNameFree(reader: RoleReader, name: string, exceptId: number | null): Promise<void> {
  const existing = await findCustomRoleByName(reader, name);
  if (existing && existing.id !== exceptId) {
    throw new ApiClientError("A role with this name already exists", 409);
  }
}

function describeRole(role: Pick<CustomRole, "permissions" | "scopeTags">) {
  return { permissions: role.permissions, scopeTags: role.scopeTags };
}

export async function listRoles(): Promise<CustomRoleView[]> {
  return await listCustomRoleViews(appDb);
}

export async function getRole(id: number): Promise<CustomRoleView> {
  const role = await readCustomRole(appDb, id);
  if (!role) throw new ApiClientError("Role not found", 404);
  return await toRoleView(appDb, role);
}

export async function createRole(actor: Access, input: unknown): Promise<CustomRoleView> {
  assertManagesRoles(actor);
  await requireFeature(FEATURE);
  const fields = readRoleFields(input, null);
  assertCanGrant(actor, grantOfRole(fields));
  const now = nowIso();
  const role = await appDb.transaction(async (tx) => {
    await assertNameFree(tx, fields.name, null);
    const row = (await first(tx
      .insert(customRoles)
      .values({
        name: fields.name,
        description: fields.description,
        permissions: JSON.stringify(fields.permissions),
        scopeTags: JSON.stringify(fields.scopeTags),
        createdBy: actor.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()))!;
    return (await readCustomRole(tx, row.id))!;
  });
  await logAuditEvent({
    userId: actor.userId,
    action: "create",
    entityType: "custom_role",
    entityId: role.id,
    summary: `Created role ${role.name}`,
    data: describeRole(role),
  });
  return await toRoleView(appDb, role);
}

function assertMayChangeRole(actor: Access, role: CustomRole): void {
  if (actor.customRole?.id === role.id) {
    throw new EscalationError("You cannot change the role you have yourself");
  }
  // A role the actor does not cover is not theirs to edit or delete.
  assertCanGrant(actor, grantOfRole(role));
}

export async function updateRole(actor: Access, id: number, input: unknown): Promise<CustomRoleView> {
  assertManagesRoles(actor);
  const existing = await readCustomRole(appDb, id);
  if (!existing) throw new ApiClientError("Role not found", 404);
  assertMayChangeRole(actor, existing);
  await requireFeature(FEATURE);
  const fields = readRoleFields(input, existing);
  assertCanGrant(actor, grantOfRole(fields));
  const now = nowIso();
  const role = await appDb.transaction(async (tx) => {
    await assertNameFree(tx, fields.name, id);
    await tx.update(customRoles)
      .set({
        name: fields.name,
        description: fields.description,
        permissions: JSON.stringify(fields.permissions),
        scopeTags: JSON.stringify(fields.scopeTags),
        updatedAt: now,
      })
      .where(eq(customRoles.id, id));
    return (await readCustomRole(tx, id))!;
  });
  await logAuditEvent({
    userId: actor.userId,
    action: "update",
    entityType: "custom_role",
    entityId: id,
    summary: `Updated role ${role.name}`,
    data: { before: { name: existing.name, ...describeRole(existing) }, after: { name: role.name, ...describeRole(role) } },
  });
  return await toRoleView(appDb, role);
}

/**
 * Deletes a role. Its users fall back to the built-in viewer role, in the same
 * transaction, and each of them is recorded in the audit log. Never needs a
 * license.
 */
export async function deleteRole(actor: Access, id: number): Promise<{ affectedUserIds: number[] }> {
  assertManagesRoles(actor);
  const existing = await readCustomRole(appDb, id);
  if (!existing) throw new ApiClientError("Role not found", 404);
  assertMayChangeRole(actor, existing);
  const now = nowIso();
  const affectedUserIds = await appDb.transaction(async (tx) => {
    const holders = await tx.select({ id: users.id }).from(users).where(eq(users.customRoleId, id));
    await tx.update(users)
      .set({ role: "viewer", customRoleId: null, updatedAt: now })
      .where(eq(users.customRoleId, id));
    await tx.delete(customRoles).where(eq(customRoles.id, id));
    // SCIM group-to-role mappings (ee/scim) to the role go with it.
    await tx.delete(scimRoleMappings).where(eq(scimRoleMappings.customRoleId, id));
    return holders.map((holder) => holder.id);
  });
  await logAuditEvent({
    userId: actor.userId,
    action: "delete",
    entityType: "custom_role",
    entityId: id,
    summary: `Deleted role ${existing.name}`,
    data: { ...describeRole(existing), affectedUserIds },
  });
  for (const userId of affectedUserIds) {
    await logAuditEvent({
      userId: actor.userId,
      action: "update",
      entityType: "user",
      entityId: userId,
      summary: `User ${userId} fell back to role viewer: role ${existing.name} was deleted`,
      data: { previousCustomRoleId: id, role: "viewer" },
    });
  }
  return { affectedUserIds };
}

/** A role to assign: a built-in role, or a custom role by id. */
export type RoleAssignment =
  | { role: BuiltInRole; customRoleId: null }
  | { role: "viewer"; customRoleId: number };

/**
 * Reads a role assignment from a request: `role` (a built-in role) and/or
 * `customRoleId` (a custom role id, or null). Returns undefined when neither
 * is present. A custom role is stored with role "viewer", so `role` may come
 * along with a custom role id only as "viewer" (a GET body sent back as it is).
 * `customRoleId: null` without a role means the built-in viewer role.
 */
export function readRoleAssignment(body: { role?: unknown; customRoleId?: unknown }): RoleAssignment | undefined {
  const hasRole = body.role !== undefined && body.role !== null && body.role !== "";
  const hasCustom = body.customRoleId !== undefined;
  if (!hasRole && !hasCustom) return undefined;
  if (hasRole && !isBuiltInRole(body.role)) {
    throw new ApiValidationError(`role must be one of: ${BUILT_IN_ROLES.join(", ")}`);
  }
  if (hasCustom && body.customRoleId !== null) {
    const id = body.customRoleId;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      throw new ApiValidationError("customRoleId must be a role id or null");
    }
    if (hasRole && body.role !== "viewer") {
      throw new ApiValidationError("Send either a built-in role or customRoleId, not both");
    }
    return { role: "viewer", customRoleId: id };
  }
  return { role: hasRole ? (body.role as RoleAssignment["role"]) : "viewer", customRoleId: null };
}

/** Parses the role picker's value: "admin", "user", "viewer" or "custom:<id>". */
export function parseRoleChoice(value: unknown): RoleAssignment | null {
  if (isBuiltInRole(value)) return { role: value, customRoleId: null };
  if (typeof value === "string" && /^custom:\d{1,9}$/.test(value)) {
    return { role: "viewer", customRoleId: Number(value.slice("custom:".length)) };
  }
  return null;
}

async function describeAssignment(reader: RoleReader, assignment: { role: string; customRoleId: number | null }): Promise<string> {
  if (assignment.customRoleId === null) return assignment.role;
  const role = await readCustomRole(reader, assignment.customRoleId);
  return role ? `custom role ${role.name}` : `custom role ${assignment.customRoleId}`;
}

/**
 * Checks that `actor` may give a new user `assignment`, and that a custom role
 * exists and is licensed. Run before the user is created.
 */
export async function assertCanAssignOnCreate(actor: Access, assignment: RoleAssignment): Promise<void> {
  assertManagesRoles(actor);
  if (assignment.customRoleId !== null) {
    await requireFeature(FEATURE);
    const role = await readCustomRole(appDb, assignment.customRoleId);
    if (!role) throw new ApiValidationError("Unknown custom role");
    assertCanGrant(actor, grantOfRole(role));
  } else {
    assertCanGrant(actor, grantOfBuiltInRole(assignment.role));
  }
}

/** Records a new user and the role they were given (built-in or custom). */
export async function auditUserCreated(actor: Access, user: Pick<User, "id" | "email" | "role" | "customRoleId">): Promise<void> {
  await logAuditEvent({
    userId: actor.userId,
    action: "create",
    entityType: "user",
    entityId: user.id,
    summary: `Created user ${user.id} (${user.email}) with role ${await describeAssignment(appDb, user)}`,
    data: { role: user.role, customRoleId: user.customRoleId },
  });
}

/**
 * Every check assignRole makes, without writing anything, so a request that
 * also changes other fields can be refused before it changes any of them.
 * Returns the custom role being assigned, if any.
 */
export async function assertCanAssignRole(
  actor: Access,
  targetUserId: number,
  assignment: RoleAssignment
): Promise<CustomRole | null> {
  assertManagesRoles(actor);
  if (actor.userId === targetUserId) {
    throw new ApiValidationError("Cannot change your own role");
  }
  await assertCanManageUserId(actor, targetUserId);
  let role: CustomRole | null = null;
  if (assignment.customRoleId !== null) {
    role = await readCustomRole(appDb, assignment.customRoleId);
    if (!role) throw new ApiValidationError("Unknown custom role");
    await requireFeature(FEATURE);
  }
  // Administrators may grant anything, manage anyone, and — acting on another
  // user while being an active administrator themselves — never remove the
  // last one; assignRole still checks all of it again in its transaction.
  if (actor.isAdmin) return role;
  const target = await first(appDb
    .select({ id: users.id, role: users.role, customRoleId: users.customRoleId })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1));
  if (target) {
    assertCanManageUser(actor, await accessForUser(target));
    assertCanGrant(actor, role ? grantOfRole(role) : grantOfBuiltInRole(assignment.role));
    await assertActiveAdminRemains(appDb, { userId: targetUserId, role: assignment.customRoleId === null ? assignment.role : "viewer" });
  }
  return role;
}

/**
 * The last-administrator guard for a status change or deletion by `actor`.
 * An administrator acting on someone else is an active administrator who
 * stays, so only non-administrators need the check (they cannot manage an
 * administrator in the first place: assertCanManageUserId).
 */
export async function assertActiveAdminRemainsFor(
  actor: Access,
  change: { userId: number; status?: string; deleted?: boolean }
): Promise<void> {
  if (actor.isAdmin && actor.userId !== change.userId) return;
  await assertActiveAdminRemains(appDb, change);
}

/**
 * Changes a user's role. Refused (403) when the actor is the user, does not
 * cover the user's current access, or may not grant the new role; refused
 * (400) when it would leave no active administrator or lock out enforced SSO.
 * Assigning a custom role needs the license; assigning a built-in role (which
 * takes a custom role away) does not. Recorded in the audit log.
 */
export async function assignRole(actor: Access, targetUserId: number, assignment: RoleAssignment): Promise<User> {
  await assertCanAssignRole(actor, targetUserId, assignment);
  let before: { role: string; customRoleId: number | null } | null = null;
  const updated = await setUserRoleAssignment(targetUserId, assignment, async (tx, current) => {
    before = { role: current.role, customRoleId: current.customRoleId ?? null };
    // Checked again on the rows as they are inside the write transaction.
    const role = assignment.customRoleId !== null ? await readCustomRole(tx, assignment.customRoleId) : null;
    if (assignment.customRoleId !== null && !role) {
      throw new ApiValidationError("Unknown custom role");
    }
    assertCanManageUser(actor, await accessForUser(current, tx));
    assertCanGrant(actor, role ? grantOfRole(role) : grantOfBuiltInRole(assignment.role));
    await assertActiveAdminRemains(tx, { userId: targetUserId, role: assignment.customRoleId === null ? assignment.role : "viewer" });
  });
  if (!updated) throw new ApiClientError("User not found", 404);
  const previous = before as { role: string; customRoleId: number | null } | null;
  await logAuditEvent({
    userId: actor.userId,
    action: "update",
    entityType: "user",
    entityId: targetUserId,
    summary: `Changed user ${targetUserId} role from ${previous ? await describeAssignment(appDb, previous) : "unknown"} to ${await describeAssignment(appDb, assignment)}`,
    data: { before: previous, after: { role: assignment.role, customRoleId: assignment.customRoleId } },
  });
  return updated;
}

/**
 * Refuses an action on user `targetUserId` (status, profile, MFA reset,
 * deletion) by a non-administrator who does not cover that user's access.
 */
export async function assertCanManageUserId(actor: Access, targetUserId: number): Promise<void> {
  if (actor.isAdmin) return;
  const target = await first(appDb
    .select({ id: users.id, role: users.role, customRoleId: users.customRoleId })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1));
  if (!target) return; // The action itself answers "not found".
  assertCanManageUser(actor, await accessForUser(target));
}

export { assertActiveAdminRemains };
