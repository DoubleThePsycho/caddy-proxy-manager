"use client";

import { SelectItem } from "@/components/ui/select";
import type { CustomRoleOption } from "./user-format";

export type RoleOptionsProps = {
  customRoles: CustomRoleOption[];
  canAssignAdmin: boolean;
};

/** The role picker's value for a user: a built-in role or "custom:<id>". */
export function roleChoice(user: { role: string; customRoleId: number | null }): string {
  return user.customRoleId !== null ? `custom:${user.customRoleId}` : user.role;
}

/**
 * The roles a picker offers. Roles the signed-in user may not grant stay
 * listed but disabled (the server checks again): the admin role and
 * administrator-level custom roles for non-administrators.
 */
export function RoleOptions({
  customRoles,
  canAssignAdmin,
  current,
}: RoleOptionsProps & { current?: string }) {
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
            disabled={value !== current && role.adminLevel && !canAssignAdmin}
          >
            {role.name}
          </SelectItem>
        );
      })}
    </>
  );
}
