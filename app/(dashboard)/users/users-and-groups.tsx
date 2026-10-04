import type { PermissionSession } from "@/src/lib/auth";
import { can, PERMISSIONS, tenantOf } from "@/src/lib/permissions";
import { listUsers } from "@/src/lib/models/user";
import { getGroupsOverview, getUsersOverview } from "@/src/lib/users-overview";
import { appDb } from "@/src/lib/db";
import { dashboardOrganizationFilter } from "@/ee/multi-tenancy/view";
import { organizationNames } from "@/ee/multi-tenancy/store";
import { isFeatureConfigurable } from "@/ee/licensing/store";
import { listRoles } from "@/ee/custom-roles/service";
import { FEATURE as CUSTOM_ROLES_FEATURE } from "@/ee/custom-roles/store";
import { RolesTabSection } from "@/ee/custom-roles/ui/RolesTabSection";
import UsersAndGroupsClient, { type UsersAndGroupsTab } from "./UsersAndGroupsClient";

/**
 * The Users and groups page for `session`, opened on `tab`: /users (users:read)
 * and /groups (groups:read) both render it, each guarded by its own
 * permission. Each tab is loaded only when the signed-in user may read it:
 * Users with users:read, Groups with groups:read, Roles with users:read at the
 * provider level (an organisation user never sees the provider's custom roles).
 */
export async function renderUsersAndGroups(session: PermissionSession, requested: UsersAndGroupsTab, selectedUserId: number | null = null) {
  const { access } = session;
  // An organisation user sees their organisation only; a provider-level user the organisation they picked (ee/multi-tenancy).
  const organizationId = await dashboardOrganizationFilter(access);
  const providerLevel = tenantOf(access) === null;
  const readUsers = can(access, "users:read");
  const readGroups = can(access, "groups:read");
  const showRoles = readUsers && providerLevel;

  const [usersOverview, groupsOverview, roles, licensed, allUsers] = await Promise.all([
    readUsers ? getUsersOverview(access, organizationId) : Promise.resolve(null),
    readGroups ? getGroupsOverview(access, organizationId) : Promise.resolve(null),
    showRoles ? listRoles() : Promise.resolve([]),
    isFeatureConfigurable(CUSTOM_ROLES_FEATURE),
    // Role holders on the Roles tab: every account, whatever organisation is picked (the tab is provider-level only).
    showRoles ? listUsers() : Promise.resolve([]),
  ]);
  const names = await organizationNames(appDb);
  const createIn = typeof organizationId === "number" ? { id: organizationId, name: names.get(organizationId) ?? `#${organizationId}` } : null;
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
      customRolesLicensed={licensed}
      totalPermissions={PERMISSIONS.length}
      organizationNames={providerLevel ? Object.fromEntries(names) : {}}
      createOrganization={createIn}
      canReadSignIn={can(access, "sso:read")}
      groups={groupsOverview?.groups ?? null}
      canWriteGroups={can(access, "groups:write")}
      rolesCount={showRoles ? roles.length + 3 : 0}
      rolesTab={
        showRoles ? <RolesTabSection access={access} roles={roles} users={allUsers} canWrite={canWrite} licensed={licensed} /> : null
      }
    />
  );
}
