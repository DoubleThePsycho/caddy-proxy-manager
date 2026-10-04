// SPDX-License-Identifier: Elastic-2.0
/**
 * Multi-tenancy: roles and organisations of users.
 *
 * Provider-level users have the built-in roles admin, user and viewer or a
 * custom role. Organisation users have org_admin (the organisation
 * administrator), user or viewer, or a custom role that only holds
 * organisation permissions (ORGANIZATION_PERMISSIONS); whatever they are
 * given, accessForUser never lets them hold more. An organisation user is
 * never "admin": the role check here refuses it, and a database trigger
 * (drizzle/0041_multi_tenancy.sql) stops any write that would slip through.
 *
 * Organisation administrators manage their organisation's users with the
 * organisation roles only; custom roles are the provider's and stay out of
 * their reach (listing, creating, changing, deleting or assigning them).
 */
import { appDb } from "@/src/lib/db";
import { ApiValidationError } from "@/src/lib/api-errors";
import {
  isOrganizationPermission,
  isOrganizationRole,
  ORGANIZATION_ADMIN_ROLE,
  ORGANIZATION_ROLES,
  tenantOf,
  type Access,
} from "@/src/lib/permissions";
import { readCustomRole, type RoleReader } from "@/ee/custom-roles/store";
import { TenantError } from "./scope";

/** Refuses a role assignment that does not fit a user of `organizationId` (null: the provider level). */
export async function assertRoleFitsTenant(
  organizationId: number | null,
  assignment: { role: string; customRoleId: number | null },
  reader: RoleReader = appDb
): Promise<void> {
  if (organizationId === null) {
    if (assignment.customRoleId === null && assignment.role === ORGANIZATION_ADMIN_ROLE) {
      throw new ApiValidationError(`"${ORGANIZATION_ADMIN_ROLE}" is the administrator role of organisation users`);
    }
    return;
  }
  if (assignment.customRoleId === null) {
    if (!isOrganizationRole(assignment.role)) {
      throw new ApiValidationError(`An organisation user's role must be one of: ${ORGANIZATION_ROLES.join(", ")}`);
    }
    return;
  }
  const role = await readCustomRole(reader, assignment.customRoleId);
  const outside = role ? role.permissions.filter((permission) => !isOrganizationPermission(permission)) : [];
  if (outside.length > 0) {
    throw new ApiValidationError(
      `The role holds permissions organisation users cannot have: ${outside.slice(0, 8).join(", ")}${outside.length > 8 ? ", ..." : ""}`
    );
  }
}

/** Refuses an organisation user managing custom roles, or assigning one. */
export function assertMayUseCustomRoles(access: Pick<Access, "organizationId">): void {
  if (tenantOf(access) !== null) {
    throw new TenantError("Custom roles are managed by your provider");
  }
}
