"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { GroupOverviewEntry, UserOverviewEntry } from "@/src/lib/users-overview";
import type { CustomRoleOption } from "./user-format";
import type { MfaPolicySummary } from "./MfaPolicyCard";
import UsersTab from "./UsersTab";
import CreateUserDialog from "./CreateUserDialog";
import GroupsTab from "../groups/GroupsTab";

export type UsersAndGroupsTab = "users" | "groups" | "roles";

type Props = {
  initialTab: UsersAndGroupsTab;
  currentUserId: number;
  /** A user whose panel opens with the page (?user=). */
  selectedUserId?: number | null;
  /** Null without users:read. */
  users: UserOverviewEntry[] | null;
  /** Null when the signed-in user's role cannot see the MFA policy. */
  mfaPolicy: MfaPolicySummary | null;
  /** users:write */
  canWrite?: boolean;
  canWriteMfaPolicy?: boolean;
  /** Only administrators grant the admin role and administrator-level roles. */
  canAssignAdmin?: boolean;
  customRoles?: CustomRoleOption[];
  totalPermissions: number;
  /** sso:read: link to Sign-in and directories. */
  canReadSignIn?: boolean;
  /** Null without groups:read. */
  groups: GroupOverviewEntry[] | null;
  canWriteGroups?: boolean;
  /** The Roles tab (ee/custom-roles/ui/RolesTab); null when it is not shown. */
  rolesTab?: ReactNode;
  rolesCount?: number;
};

const TAB_PATHS: Record<UsersAndGroupsTab, string> = {
  users: "/users",
  groups: "/groups",
  roles: "/users?tab=roles",
};

function TabCount({ value }: { value: number }) {
  return <span className="num rounded-full bg-raise px-1.5 text-[11px] leading-[18px] font-normal text-muted-foreground">{value}</span>;
}

/**
 * Users and groups: the Users, Groups and Roles tabs of the Identity section.
 * Switching tabs keeps the address in step (/users, /groups,
 * /users?tab=roles) so a reload or a shared link opens the same tab.
 */
export default function UsersAndGroupsClient({
  initialTab,
  currentUserId,
  selectedUserId = null,
  users,
  mfaPolicy,
  canWrite = false,
  canWriteMfaPolicy = false,
  canAssignAdmin = false,
  customRoles = [],
  totalPermissions,
  canReadSignIn = false,
  groups,
  canWriteGroups = false,
  rolesTab = null,
  rolesCount = 0,
}: Props) {
  const [tab, setTab] = useState<UsersAndGroupsTab>(initialTab);
  const [creating, setCreating] = useState(false);
  const tabs: { id: UsersAndGroupsTab; label: string; count: number }[] = [];
  if (users) tabs.push({ id: "users", label: "Users", count: users.length });
  if (groups) tabs.push({ id: "groups", label: "Groups", count: groups.length });
  if (rolesTab) tabs.push({ id: "roles", label: "Roles", count: rolesCount });

  const choose = (next: string) => {
    const value = next as UsersAndGroupsTab;
    setTab(value);
    try {
      window.history.replaceState(null, "", TAB_PATHS[value]);
    } catch {
      // The address is a convenience; the tab works without it.
    }
  };

  const roleOptions = { customRoles, canAssignAdmin };

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <Tabs value={tab} onValueChange={choose} className="flex min-w-0 flex-col gap-5">
        <PageHeader
          className="mb-0"
          breadcrumb={["Users and sign-in", "Users and groups"]}
          title="Users and groups"
          actions={
            <>
              {canReadSignIn && (
                <Button asChild variant="outline">
                  <Link href="/sign-in">Sign-in and directories</Link>
                </Button>
              )}
              {users && canWrite && (
                <Button onClick={() => setCreating(true)}>
                  <Plus />
                  Add user
                </Button>
              )}
            </>
          }
        >
          {tabs.length > 1 && (
            <TabsList aria-label="Users and groups sections">
              {tabs.map((entry) => (
                <TabsTrigger key={entry.id} value={entry.id}>
                  {entry.label} <TabCount value={entry.count} />
                </TabsTrigger>
              ))}
            </TabsList>
          )}
        </PageHeader>

        {users && (
          <TabsContent value="users" className="mt-0">
            <UsersTab
              users={users}
              currentUserId={currentUserId}
              selectedUserId={selectedUserId}
              mfaPolicy={mfaPolicy}
              canWrite={canWrite}
              canWriteMfaPolicy={canWriteMfaPolicy}
              roleOptions={roleOptions}
              totalPermissions={totalPermissions}
              onAddUser={canWrite ? () => setCreating(true) : undefined}
            />
          </TabsContent>
        )}
        {groups && (
          <TabsContent value="groups" className="mt-0">
            <GroupsTab groups={groups} users={users} canWrite={canWriteGroups} />
          </TabsContent>
        )}
        {rolesTab && (
          <TabsContent value="roles" className="mt-0">
            {rolesTab}
          </TabsContent>
        )}
      </Tabs>

      {users && canWrite && (
        <CreateUserDialog
          open={creating}
          onClose={() => setCreating(false)}
          roleOptions={roleOptions}
        />
      )}
    </div>
  );
}
