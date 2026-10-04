"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/src/lib/auth";
import { assertCanManageUserId } from "@/ee/custom-roles/service";
import { ApiClientError } from "@/src/lib/api-errors";
import { adminResetUserMfa, parseMfaPolicyInput, updateMfaPolicy } from "@/src/lib/mfa";
import type { UserActionResult } from "./actions";
import { routeRowId } from "@/src/lib/row-ids";

function failure(error: unknown, action: string): UserActionResult {
  if (error instanceof ApiClientError) return { ok: false, error: error.message };
  console.error(`Failed to ${action}:`, error);
  return { ok: false, error: `Failed to ${action}` };
}

/** Saves the MFA policy (the same as PUT /api/v1/mfa/policy). */
export async function updateMfaPolicyAction(scope: string, graceDays: number): Promise<UserActionResult> {
  const session = await requirePermission("mfa_policy:write");
  try {
    await updateMfaPolicy(parseMfaPolicyInput({ scope, graceDays }), Number(session.user.id));
  } catch (error) {
    return failure(error, "save the MFA policy");
  }
  revalidatePath("/users");
  return { ok: true };
}

/** Turns MFA off for another user (the same as DELETE /api/v1/users/{id}/mfa). */
export async function resetUserMfaAction(userId: number): Promise<UserActionResult> {
  const session = await requirePermission("users:write");
  try {
    const targetId = routeRowId(String(userId), "User not found");
    await assertCanManageUserId(session.access, targetId);
    await adminResetUserMfa(targetId, Number(session.user.id));
  } catch (error) {
    return failure(error, "reset MFA");
  }
  revalidatePath("/users");
  return { ok: true };
}
