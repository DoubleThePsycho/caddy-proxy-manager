"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/src/lib/auth";
import { ApiClientError } from "@/src/lib/api-errors";
import {
  createGroup,
  updateGroup,
  deleteGroup,
  addGroupMember,
  removeGroupMember
} from "@/src/lib/models/groups";

export type GroupActionResult = { ok: true } | { ok: false; error: string };

/**
 * Client-safe refusals (a taken or missing name, a member already in the
 * group, a group or member not found) come back as { ok: false } with their
 * message, which production builds would otherwise hide; anything else is thrown.
 */
async function run(operation: () => Promise<unknown>): Promise<GroupActionResult> {
  try {
    await operation();
    revalidatePath("/groups");
    revalidatePath("/users");
    return { ok: true };
  } catch (error) {
    if (error instanceof ApiClientError) return { ok: false, error: error.message };
    if (error instanceof Error && /not found( in group)?$/i.test(error.message)) return { ok: false, error: error.message };
    throw error;
  }
}

function textField(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === "string" ? value : null;
}

export async function createGroupAction(formData: FormData): Promise<GroupActionResult> {
  const session = await requirePermission("groups:write");
  const userId = Number(session.user.id);
  return run(() => createGroup({ name: textField(formData, "name") ?? "", description: textField(formData, "description") }, userId));
}

export async function updateGroupAction(id: number, formData: FormData): Promise<GroupActionResult> {
  const session = await requirePermission("groups:write");
  const userId = Number(session.user.id);
  return run(() => updateGroup(id, { name: textField(formData, "name") ?? "", description: textField(formData, "description") }, userId));
}

export async function deleteGroupAction(id: number): Promise<GroupActionResult> {
  const session = await requirePermission("groups:write");
  const userId = Number(session.user.id);
  return run(() => deleteGroup(id, userId));
}

export async function addGroupMemberAction(groupId: number, memberId: number): Promise<GroupActionResult> {
  const session = await requirePermission("groups:write");
  const userId = Number(session.user.id);
  return run(() => addGroupMember(groupId, memberId, userId));
}

export async function removeGroupMemberAction(groupId: number, memberId: number): Promise<GroupActionResult> {
  const session = await requirePermission("groups:write");
  const userId = Number(session.user.id);
  return run(() => removeGroupMember(groupId, memberId, userId));
}
