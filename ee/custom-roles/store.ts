// SPDX-License-Identifier: Elastic-2.0
/**
 * Custom roles: storage and the reads the request path uses.
 *
 * Everything here takes a database reader (the database or a transaction on
 * it), so a check and the write it guards can share one transaction.
 */
import { count, eq } from "drizzle-orm";
import { toIso } from "@/src/lib/db";
import { customRoles, users } from "@/src/lib/db/schema";
import { parseStoredTags } from "@/src/lib/host-tags";
import { isAdminLevel, isPermission, PERMISSIONS, type Permission } from "@/src/lib/permissions";
import { asc, first } from "@/src/lib/db/ops";
import type { DbExecutor } from "@/src/lib/db/types";

/** The database or a transaction on it, for reads. */
export type RoleReader = Pick<DbExecutor, "select">;

/** The database or a transaction on it, for reads and writes. */
export type RoleWriter = Pick<DbExecutor, "select" | "insert" | "update" | "delete">;

export type CustomRole = {
  id: number;
  name: string;
  description: string | null;
  permissions: Permission[];
  /** Tags limiting proxy hosts, L4 proxy hosts and certificates; empty means every host. */
  scopeTags: string[];
  createdAt: string;
  updatedAt: string;
};

export type CustomRoleView = CustomRole & {
  /** Users that have the role. */
  userCount: number;
  /** Only administrators can grant it (see isAdminLevel in src/lib/permissions.ts). */
  adminLevel: boolean;
};

type CustomRoleRow = typeof customRoles.$inferSelect;

/**
 * Permissions as stored. A name this release does not know (a row written by
 * a newer release, or edited by hand) is dropped, never widened into another
 * permission.
 */
function parseStoredPermissions(raw: string | null | undefined): Permission[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const held = new Set(value.filter(isPermission));
    return PERMISSIONS.filter((permission) => held.has(permission));
  } catch {
    return [];
  }
}

export function parseRoleRow(row: CustomRoleRow): CustomRole {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    permissions: parseStoredPermissions(row.permissions),
    scopeTags: parseStoredTags(row.scopeTags),
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
  };
}

export async function readCustomRole(reader: RoleReader, id: number): Promise<CustomRole | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const row = await first(reader.select().from(customRoles).where(eq(customRoles.id, id)).limit(1));
  return row ? parseRoleRow(row) : null;
}

export async function findCustomRoleByName(reader: RoleReader, name: string): Promise<CustomRole | null> {
  const wanted = name.trim().toLowerCase();
  const rows = await reader.select().from(customRoles);
  const row = rows.find((candidate) => candidate.name.toLowerCase() === wanted);
  return row ? parseRoleRow(row) : null;
}

export async function countRoleUsers(reader: RoleReader, id: number): Promise<number> {
  const row = await first(reader.select({ value: count() }).from(users).where(eq(users.customRoleId, id)).limit(1));
  return row?.value ?? 0;
}

export async function toRoleView(reader: RoleReader, role: CustomRole): Promise<CustomRoleView> {
  return { ...role, userCount: await countRoleUsers(reader, role.id), adminLevel: isAdminLevel(role.permissions) };
}

export async function listCustomRoleViews(reader: RoleReader): Promise<CustomRoleView[]> {
  const rows = await reader.select().from(customRoles).orderBy(asc(customRoles.name), asc(customRoles.id));
  const counts = new Map<number, number>();
  for (const row of await reader.select({ customRoleId: users.customRoleId }).from(users)) {
    if (row.customRoleId !== null) counts.set(row.customRoleId, (counts.get(row.customRoleId) ?? 0) + 1);
  }
  return rows.map((row) => {
    const role = parseRoleRow(row);
    return { ...role, userCount: counts.get(role.id) ?? 0, adminLevel: isAdminLevel(role.permissions) };
  });
}
