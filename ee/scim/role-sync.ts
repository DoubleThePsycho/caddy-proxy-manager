// SPDX-License-Identifier: Elastic-2.0
/**
 * Roles of SCIM users. Roles never come from SCIM attributes (a `roles`
 * attribute is ignored); while the SCIM settings let SCIM manage roles, a
 * SCIM user gets the role of the first group-to-role mapping whose group the
 * identity provider put them in, and the default role when none applies. Protected accounts
 * (primary admin, break-glass accounts) are never touched.
 *
 * A change that would leave no active administrator, or no break-glass
 * administrator while SSO is enforced, is refused for that user and recorded;
 * the SCIM request that caused it still succeeds.
 */
import { and, eq, isNull } from "drizzle-orm";
import { groups, scimGroupMembers, scimGroups, scimRoleMappings, scimUsers, users } from "@/src/lib/db/schema";
import { nowIso } from "@/src/lib/db";
import { ApiClientError } from "@/src/lib/api-errors";
import { assertBreakGlassAdminRemains } from "@/ee/sso/enforcement-store";
import { assertActiveAdminRemains } from "@/ee/custom-roles/escalation";
import { readCustomRole } from "@/ee/custom-roles/store";
import { isProtectedUser, type ScimWriter } from "./store";
import type { ScimSettings } from "./types";
import type { ScimAuditEvent } from "./audit";
import { asc, first } from "@/src/lib/db/ops";

export type RoleAssignment = { role: string; customRoleId: number | null };

/**
 * What the mappings give user `userId` now. Only memberships the identity
 * provider asserted through SCIM (scim_group_members) in groups SCIM still
 * manages count: a membership added or removed by hand on the Groups page
 * never changes a role.
 */
export async function mappedRole(tx: ScimWriter, userId: number, settings: ScimSettings): Promise<RoleAssignment> {
  const memberOf = new Set(
    (await tx.select({ groupId: scimGroupMembers.groupId })
      .from(scimGroupMembers)
      .innerJoin(scimGroups, eq(scimGroups.groupId, scimGroupMembers.groupId))
      .innerJoin(groups, eq(groups.id, scimGroupMembers.groupId))
      .where(eq(scimGroupMembers.userId, userId)))
      .map((row) => row.groupId)
  );
  const mappings = await tx
    .select()
    .from(scimRoleMappings)
    .orderBy(asc(scimRoleMappings.priority), asc(scimRoleMappings.id));
  for (const mapping of mappings) {
    if (!memberOf.has(mapping.groupId)) continue;
    if (mapping.customRoleId !== null) {
      // A mapping to a custom role that no longer exists grants nothing.
      if (!await readCustomRole(tx, mapping.customRoleId)) continue;
      return { role: "viewer", customRoleId: mapping.customRoleId };
    }
    if (mapping.role === "admin" || mapping.role === "user" || mapping.role === "viewer") {
      return { role: mapping.role, customRoleId: null };
    }
  }
  return { role: settings.defaultRole, customRoleId: null };
}

function describe(assignment: RoleAssignment): string {
  return assignment.customRoleId !== null ? `custom role ${assignment.customRoleId}` : assignment.role;
}

/**
 * Brings user `userId`'s role in line with the mappings, inside `tx`.
 * Returns the audit event of a change or refusal, or null when nothing was
 * to be done.
 */
export async function syncUserRole(tx: ScimWriter, userId: number, settings: ScimSettings): Promise<ScimAuditEvent | null> {
  if (!settings.manageRoles || await isProtectedUser(tx, userId)) return null;
  const managed = await first(tx
    .select({ id: scimUsers.id })
    .from(scimUsers)
    .where(and(eq(scimUsers.userId, userId), isNull(scimUsers.deletedAt)))
    .limit(1));
  if (!managed) return null;
  const current = await first(tx
    .select({ role: users.role, customRoleId: users.customRoleId, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1));
  if (!current) return null;
  const desired = await mappedRole(tx, userId, settings);
  const before: RoleAssignment = { role: current.role, customRoleId: current.customRoleId ?? null };
  if (before.role === desired.role && before.customRoleId === desired.customRoleId) return null;
  try {
    await assertBreakGlassAdminRemains(tx, { userId, role: desired.role });
    await assertActiveAdminRemains(tx, { userId, role: desired.role });
  } catch (error) {
    if (!(error instanceof ApiClientError)) throw error;
    return {
      action: "scim_role_change_refused",
      entityType: "user",
      entityId: userId,
      summary: `kept user ${userId} (${current.email}) as ${describe(before)} instead of ${describe(desired)}: ${error.message}`,
      data: { before, wanted: desired, reason: error.message },
    };
  }
  await tx.update(users)
    .set({ role: desired.role, customRoleId: desired.customRoleId, updatedAt: nowIso() })
    .where(eq(users.id, userId));
  return {
    action: "scim_role_change",
    entityType: "user",
    entityId: userId,
    summary: `changed user ${userId} (${current.email}) role from ${describe(before)} to ${describe(desired)} (group-to-role mapping)`,
    data: { before, after: desired },
  };
}

/** syncUserRole for every SCIM user; returns the audit events. */
export async function syncAllUserRoles(tx: ScimWriter, settings: ScimSettings): Promise<ScimAuditEvent[]> {
  if (!settings.manageRoles) return [];
  const ids = await tx.select({ userId: scimUsers.userId }).from(scimUsers).where(isNull(scimUsers.deletedAt));
  const events: ScimAuditEvent[] = [];
  for (const { userId } of ids) {
    const event = await syncUserRole(tx, userId, settings);
    if (event) events.push(event);
  }
  return events;
}
