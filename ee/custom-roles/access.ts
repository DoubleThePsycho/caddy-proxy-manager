// SPDX-License-Identifier: Elastic-2.0
/**
 * Resolves what a user may do, on every guarded request. This is the runtime
 * path of custom roles: it never checks the license, so roles and their
 * assignments keep working when the license lapses.
 */
import { appDb } from "@/src/lib/db";
import { builtInAccess, type Access } from "@/src/lib/permissions";
import { readCustomRole, type RoleReader } from "./store";

export type AccessSubject = {
  id: number;
  /** users.role as stored. */
  role: string;
  customRoleId: number | null | undefined;
};

/**
 * The user's access. A custom role applies whenever the user has one (its
 * users are stored with role "viewer"); a custom role that no longer exists
 * grants nothing, which is the built-in viewer role. Otherwise the built-in
 * role decides: "admin" holds every permission, anything else none.
 */
export async function accessForUser(user: AccessSubject, reader: RoleReader = appDb): Promise<Access> {
  const customRoleId = user.customRoleId ?? null;
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
  };
}
