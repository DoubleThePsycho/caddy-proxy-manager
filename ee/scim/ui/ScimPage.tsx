// SPDX-License-Identifier: Elastic-2.0
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { listUsers } from "@/src/lib/models/user";
import { listGroups } from "@/src/lib/models/groups";
import { appDb } from "@/src/lib/db";
import { listRoles } from "@/ee/custom-roles/service";
import {
  getScimSettingsView,
  listManagedGroups,
  listManagedUsers,
  listRoleMappings,
} from "@/ee/scim/service";
import { isProtectedUser } from "@/ee/scim/store";
import { listScimTokens } from "@/ee/scim/tokens";
import ScimClient from "@/ee/scim/ui/ScimClient";

export const metadata = { title: "SCIM provisioning" };

export default async function ScimPage() {
  const { access } = await requirePermission("scim:read");
  // Every view below is free of secrets (tokens show only their prefix).
  const [settings, tokens, users, groups, roles] = await Promise.all([
    getScimSettingsView(),
    listScimTokens(),
    listUsers(),
    listGroups(),
    listRoles(),
  ]);
  const managedUsers = await listManagedUsers();
  const managedGroups = await listManagedGroups();
  const managedUserIds = new Set(managedUsers.filter((user) => user.deletedAt === null).map((user) => user.userId));
  const managedGroupIds = new Set(managedGroups.map((group) => group.groupId));
  // The primary admin and break-glass accounts are never offered (a read per user, in order).
  const userOptions: Array<{ id: number; email: string; name: string | null }> = [];
  for (const user of users) {
    if (managedUserIds.has(user.id) || await isProtectedUser(appDb, user.id)) continue;
    userOptions.push({ id: user.id, email: user.email, name: user.name });
  }
  return (
    <ScimClient
      settings={settings}
      tokens={tokens}
      mappings={await listRoleMappings()}
      managedUsers={managedUsers}
      managedGroups={managedGroups}
      userOptions={userOptions}
      groupOptions={groups.filter((group) => !managedGroupIds.has(group.id)).map((group) => ({ id: group.id, name: group.name }))}
      customRoles={roles.map((role) => ({ id: role.id, name: role.name, adminLevel: role.adminLevel }))}
      canWrite={can(access, "scim:write")}
      isAdmin={access.isAdmin}
      canReadSignIn={can(access, "sso:read")}
    />
  );
}
