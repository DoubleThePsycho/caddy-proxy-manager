// SPDX-License-Identifier: Elastic-2.0
/**
 * Escalation guards for roles. Every rule here is about who may hand out
 * access:
 *
 *  - Only a user with users:write manages roles and assignments (the callers'
 *    permission guard; checked again here).
 *  - Nobody grants a permission they do not hold, or a wider tag scope than
 *    their own for the scopable areas (covers()).
 *  - Only administrators grant the built-in admin role or an
 *    administrator-level role (isAdminLevel in src/lib/permissions.ts).
 *  - A non-administrator only manages users whose access they cover
 *    themselves, so they can never change, disable or delete an administrator.
 *  - Nobody changes their own role, or edits or deletes the custom role they hold.
 *  - The last active administrator cannot be demoted, disabled or deleted.
 */
import { and, count, eq, isNull, ne } from "drizzle-orm";
import { users } from "@/src/lib/db/schema";
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import {
  can,
  isAdminLevel,
  isScopableArea,
  permissionArea,
  PERMISSIONS,
  type Access,
  type Permission,
} from "@/src/lib/permissions";
import type { CustomRole, RoleReader } from "./store";
import { first } from "@/src/lib/db/ops";

/** Access a role (or a user) would give. */
export type Grant = {
  isAdmin: boolean;
  permissions: ReadonlySet<Permission>;
  scopeTags: readonly string[];
};

export function grantOfAccess(access: Access): Grant {
  return {
    isAdmin: access.isAdmin,
    permissions: access.isAdmin ? new Set(PERMISSIONS) : access.permissions,
    scopeTags: access.scopeTags,
  };
}

export function grantOfRole(role: Pick<CustomRole, "permissions" | "scopeTags">): Grant {
  return { isAdmin: false, permissions: new Set(role.permissions), scopeTags: role.scopeTags };
}

export function grantOfBuiltInRole(role: string): Grant {
  return { isAdmin: role === "admin", permissions: role === "admin" ? new Set(PERMISSIONS) : new Set(), scopeTags: [] };
}

/**
 * True when `actor` holds everything `grant` gives: every permission, and for
 * the scopable areas a scope at least as wide (an unscoped actor covers any
 * scope; a scoped actor only covers scopes made of its own tags).
 */
export function covers(actor: Access, grant: Grant): boolean {
  if (actor.isAdmin) return true;
  if (grant.isAdmin) return false;
  for (const permission of grant.permissions) {
    if (!actor.permissions.has(permission)) return false;
    if (isScopableArea(permissionArea(permission)) && actor.scopeTags.length > 0) {
      if (grant.scopeTags.length === 0) return false;
      if (!grant.scopeTags.every((tag) => actor.scopeTags.includes(tag))) return false;
    }
  }
  return true;
}

export class EscalationError extends ApiClientError {
  constructor(message: string) {
    super(message, 403);
    this.name = "EscalationError";
  }
}

export function assertManagesRoles(actor: Access): void {
  if (!can(actor, "users:write")) {
    throw new EscalationError("Managing roles needs the users:write permission");
  }
}

/** Refuses handing out `grant` (assigning it or saving it as a role) unless the actor may. */
export function assertCanGrant(actor: Access, grant: Grant): void {
  assertManagesRoles(actor);
  if (actor.isAdmin) return;
  if (grant.isAdmin || isAdminLevel(grant.permissions)) {
    throw new EscalationError("Only administrators can grant administrator-level permissions");
  }
  if (!covers(actor, grant)) {
    throw new EscalationError("You can only grant permissions and host scopes that you hold yourself");
  }
}

/** Refuses acting on a user whose access the actor does not cover (administrators always may). */
export function assertCanManageUser(actor: Access, target: Access): void {
  if (actor.isAdmin) return;
  if (!covers(actor, grantOfAccess(target))) {
    throw new EscalationError("You cannot manage a user who has access you do not have");
  }
}

export const LAST_ADMIN_MESSAGE = "This change would leave no active administrator";

/**
 * Refuses a change that takes the last active administrator away: demoting,
 * disabling or deleting user `userId` when no other active administrator
 * remains. Call it inside the transaction that makes the change.
 */
export async function assertActiveAdminRemains(
  reader: RoleReader,
  change: { userId: number; role?: string; status?: string; deleted?: boolean }
): Promise<void> {
  const current = await first(reader
    .select({ role: users.role, status: users.status, customRoleId: users.customRoleId })
    .from(users)
    .where(eq(users.id, change.userId))
    .limit(1));
  if (!current || current.role !== "admin" || current.status !== "active" || current.customRoleId !== null) return;
  const staysAdmin =
    !change.deleted &&
    (change.role === undefined || change.role === "admin") &&
    (change.status === undefined || change.status === "active");
  if (staysAdmin) return;
  const others = await first(reader
    .select({ value: count() })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.status, "active"), isNull(users.customRoleId), ne(users.id, change.userId)))
    .limit(1));
  if ((others?.value ?? 0) === 0) {
    throw new ApiValidationError(LAST_ADMIN_MESSAGE);
  }
}
