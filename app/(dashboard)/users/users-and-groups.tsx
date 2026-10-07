import type { PermissionSession } from "@/src/lib/auth";
import { can, PERMISSIONS } from "@/src/lib/permissions";
import { listUsers } from "@/src/lib/models/user";
import { getGroupsOverview, getUsersOverview } from "@/src/lib/users-overview";
import { listRoles } from "@/ee/custom-roles/service";
import { RolesTabSection } from "@/ee/custom-roles/ui/RolesTabSection";
import UsersAndGroupsClient, { type UsersAndGroupsTab } from "./UsersAndGroupsClient";

/**
 * The Users and groups page for `session`, opened on `tab`: /users (users:read)
 * and /groups (groups:read) both render it, each guarded by its own
 * permission. Each tab is loaded only when the signed-in user may read it:
 * Users with users:read, Groups with groups:read, Roles with users:read.
 */
export async function renderUsersAndGroups(session: PermissionSession, requested: UsersAndGroupsTab, selectedUserId: number | null = null) {
  const { access } = session;
  const readUsers = can(access, "users:read");
  const readGroups = can(access, "groups:read");
  const showRoles = readUsers;

  const [usersOverview, groupsOverview, roles, allUsers] = await Promise.all([
    readUsers ? getUsersOverview(access) : Promise.resolve(null),
    readGroups ? getGroupsOverview(access) : Promise.resolve(null),
    showRoles ? listRoles() : Promise.resolve([]),
    // Role holders on the Roles tab: every account.
    showRoles ? listUsers() : Promise.resolve([]),
  ]);
  const canWrite = can(access, "users:write");

  const tab: UsersAndGroupsTab =
    requested === "roles" && showRoles ? "roles"
      : requested === "groups" && readGroups ? "groups"
        : readUsers ? "users" : "groups";

  return (
    <UsersAndGroupsClient
      initialTab={tab}
      currentUserId={Number(session.user.id)}
      selectedUserId={selectedUserId}
      users={usersOverview?.users ?? null}
      mfaPolicy={usersOverview?.mfaPolicy ?? null}
      canWrite={canWrite}
      canWriteMfaPolicy={can(access, "mfa_policy:write")}
      canAssignAdmin={access.isAdmin}
      customRoles={roles.map((role) => ({
        id: role.id,
        name: role.name,
        adminLevel: role.adminLevel,
        permissionCount: role.permissions.length,
        scopeTags: role.scopeTags,
      }))}
      totalPermissions={PERMISSIONS.length}
      canReadSignIn={can(access, "sso:read")}
      groups={groupsOverview?.groups ?? null}
      canWriteGroups={can(access, "groups:write")}
      rolesCount={showRoles ? roles.length + 3 : 0}
      rolesTab={
        showRoles ? <RolesTabSection access={access} roles={roles} users={allUsers} canWrite={canWrite} /> : null
      }
    />
  );
}
