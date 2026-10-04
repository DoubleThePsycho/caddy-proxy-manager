// SPDX-License-Identifier: Elastic-2.0
"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/src/lib/auth";
import { ApiClientError } from "@/src/lib/api-errors";
import { createRole, deleteRole, updateRole } from "@/ee/custom-roles/service";
import { routeRowId } from "@/src/lib/row-ids";

/** As the Users page's actions answer: a refusal is returned, not thrown. */
type UserActionResult = { ok: true } | { ok: false; error: string };

function failure(error: unknown, action: string): UserActionResult {
  if (error instanceof ApiClientError) return { ok: false, error: error.message };
  console.error(`Failed to ${action}:`, error);
  return { ok: false, error: `Failed to ${action}` };
}

/** Creates (id null) or changes a custom role, as POST/PUT /api/v1/roles do. Needs the custom_roles license feature. */
export async function saveRoleAction(id: number | null, input: unknown): Promise<UserActionResult> {
  const session = await requirePermission("users:write");
  try {
    if (id === null) await createRole(session.access, input);
    else await updateRole(session.access, routeRowId(String(id), "Role not found"), input);
  } catch (error) {
    return failure(error, "save the role");
  }
  revalidatePath("/users");
  return { ok: true };
}

/** Deletes a custom role; its users fall back to the viewer role. Never needs a license. */
export async function deleteRoleAction(id: number): Promise<UserActionResult> {
  const session = await requirePermission("users:write");
  try {
    await deleteRole(session.access, routeRowId(String(id), "Role not found"));
  } catch (error) {
    return failure(error, "delete the role");
  }
  revalidatePath("/users");
  return { ok: true };
}
