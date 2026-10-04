// SPDX-License-Identifier: Elastic-2.0
/**
 * Resolves what a user may do, on every guarded request. This is the runtime
 * path of custom roles: it never checks the license, so roles and their
 * assignments keep working when the license lapses.
 */
import { appDb } from "@/src/lib/db";
import { builtInAccess, organizationAccess, type Access } from "@/src/lib/permissions";
import { isOrganizationEnabled, userOrganizationId } from "@/ee/multi-tenancy/store";
import { readCustomRole, type RoleReader } from "./store";

export type AccessSubject = {
  id: number;
  /** users.role as stored. */
  role: string;
  customRoleId: number | null | undefined;
  /**
   * users.organizationId as stored (ee/multi-tenancy), read with the role.
   * Left out, it is read from the database here.
   */
  organizationId?: number | null;
};

/**
 * The user's access. A custom role applies whenever the user has one (its
 * users are stored with role "viewer"); a custom role that no longer exists
 * grants nothing, which is the built-in viewer role. Otherwise the built-in
 * role decides: "admin" holds every permission, anything else none.
 *
 * A user of an organisation (ee/multi-tenancy) is confined to it: never an
 * administrator, and at most the organisation permissions, which "org_admin"
 * holds all of. A user of a disabled (or deleted) organisation holds nothing.
 */
export async function accessForUser(user: AccessSubject, reader: RoleReader = appDb): Promise<Access> {
  const customRoleId = user.customRoleId ?? null;
  const organizationId = user.organizationId === undefined ? await userOrganizationId(reader, user.id) : user.organizationId;
  if (organizationId !== null) {
    if (!await isOrganizationEnabled(reader, organizationId)) return organizationAccess(user.id, organizationId, "viewer");
    const role = customRoleId === null ? null : await readCustomRole(reader, customRoleId);
    // A custom role that no longer exists grants nothing, as at the provider level.
    if (customRoleId !== null && !role) return organizationAccess(user.id, organizationId, "viewer");
    return organizationAccess(user.id, organizationId, user.role, role);
  }
  if (customRoleId === null) return builtInAccess(user.id, user.role);
  const role = await readCustomRole(reader, customRoleId);
  if (!role) return builtInAccess(user.id, user.role === "admin" ? "viewer" : user.role);
  return {
    userId: user.id,
    role: user.role,
    isAdmin: false,
    customRole: { id: role.id, name: role.name },
    permissions: new Set(role.permissions),
    scopeTags: role.scopeTags,
    organizationId: null,
  };
}
