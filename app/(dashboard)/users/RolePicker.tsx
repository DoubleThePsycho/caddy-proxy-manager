"use client";

import { SelectItem } from "@/components/ui/select";
import type { CustomRoleOption } from "./user-format";

export type RoleOptionsProps = {
  customRoles: CustomRoleOption[];
  canAssignAdmin: boolean;
  customRolesLicensed: boolean;
};

/** The role picker's value for a user: a built-in role or "custom:<id>". */
export function roleChoice(user: { role: string; customRoleId: number | null }): string {
  return user.customRoleId !== null ? `custom:${user.customRoleId}` : user.role;
}

/**
 * The roles a picker offers. Roles the signed-in user may not grant stay
 * listed but disabled (the server checks again): the admin role and
 * administrator-level custom roles for non-administrators, custom roles
 * without a license. An organisation user (ee/multi-tenancy) gets the
 * organisation's roles.
 */
export function RoleOptions({
  customRoles,
  canAssignAdmin,
  customRolesLicensed,
  current,
  organization = false,
}: RoleOptionsProps & { current?: string; organization?: boolean }) {
  if (organization) {
    return (
      <>
        <SelectItem value="org_admin">Organisation admin</SelectItem>
        <SelectItem value="user">User</SelectItem>
        <SelectItem value="viewer">Viewer</SelectItem>
        {current?.startsWith("custom:") && (
          <SelectItem value={current} disabled>
            {customRoles.find((role) => `custom:${role.id}` === current)?.name ?? "Custom role"}
          </SelectItem>
        )}
      </>
    );
  }
  return (
    <>
      <SelectItem value="admin" disabled={!canAssignAdmin && current !== "admin"}>Admin</SelectItem>
      <SelectItem value="user">User</SelectItem>
      <SelectItem value="viewer">Viewer</SelectItem>
      {customRoles.map((role) => {
        const value = `custom:${role.id}`;
        return (
          <SelectItem
            key={role.id}
            value={value}
            disabled={value !== current && (!customRolesLicensed || (role.adminLevel && !canAssignAdmin))}
          >
            {role.name}
          </SelectItem>
        );
      })}
    </>
  );
}
