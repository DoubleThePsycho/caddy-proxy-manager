// SPDX-License-Identifier: Elastic-2.0
import { listHeldPermissions, type Access } from "@/src/lib/permissions";
import { EDITION_LABELS, FEATURE_INFO } from "@/ee/licensing/features";
import { describePermissionCatalogue } from "@/ee/custom-roles/catalogue";
import { FEATURE, type CustomRoleView } from "@/ee/custom-roles/store";
import RolesTab from "./RolesTab";
import { deleteRoleAction, saveRoleAction } from "./actions";

/** An account as the Roles tab names its holders. */
export type RoleHolderUser = { name: string | null; email: string; status: string; role: string; customRoleId: number | null };

/**
 * The Roles tab of the Users and groups page (server side): every role with
 * the accounts that hold it, the permission catalogue and what the signed-in
 * user may grant. `users` is every account.
 */
export function RolesTabSection({
  access,
  roles,
  users,
  canWrite,
  licensed,
}: {
  access: Access;
  roles: CustomRoleView[];
  users: RoleHolderUser[];
  canWrite: boolean;
  licensed: boolean;
}) {
  const holderName = (user: RoleHolderUser) => `${user.name || user.email}${user.status === "active" ? "" : " (disabled)"}`;
  return (
    <RolesTab
      roles={roles}
      catalogue={describePermissionCatalogue()}
      actor={{
        isAdmin: access.isAdmin,
        permissions: listHeldPermissions(access),
        scopeTags: [...access.scopeTags],
        customRoleId: access.customRole?.id ?? null,
      }}
      holders={{
        admin: users.filter((user) => user.role === "admin" && user.customRoleId === null).map(holderName),
        user: users.filter((user) => user.role === "user" && user.customRoleId === null).map(holderName),
        viewer: users.filter((user) => user.role === "viewer" && user.customRoleId === null).map(holderName),
        custom: Object.fromEntries(roles.map((role) => [role.id, users.filter((user) => user.customRoleId === role.id).map(holderName)])),
      }}
      canWrite={canWrite}
      licensed={licensed}
      editionLabel={EDITION_LABELS[FEATURE_INFO[FEATURE].edition]}
      saveRole={saveRoleAction}
      deleteRole={deleteRoleAction}
    />
  );
}
