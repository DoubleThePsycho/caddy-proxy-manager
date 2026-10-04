"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/src/lib/auth";
import {
  createUser,
  updateUserAccount,
  updateUserStatus,
  deleteUser,
  type User,
} from "@/src/lib/models/user";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiClientError } from "@/src/lib/api-errors";
import { passwordPolicyMessage } from "@/src/lib/password-policy";
import {
  assertActiveAdminRemainsFor,
  assertCanAssignOnCreate,
  assertCanManageUserId,
  assignRole,
  auditUserCreated,
  parseRoleChoice,
} from "@/ee/custom-roles/service";
import { tenantOf } from "@/src/lib/permissions";
import { organizationForNewRow } from "@/ee/multi-tenancy/scope";
import { dashboardCreateOrganization } from "@/ee/multi-tenancy/view";
import { isUniqueViolation } from "@/src/lib/db/ops";

const VALID_STATUSES = new Set(["active", "disabled"]);

/**
 * Outcome of a user-management action. Problems the admin can fix come back
 * as `error` for the page to show inline; a thrown error would replace the
 * whole page with the error screen (and lose the form).
 */
export type UserActionResult = { ok: true } | { ok: false; error: string };

function failure(error: string): UserActionResult {
  return { ok: false, error };
}

/**
 * Maps an error from the model to a message for the admin. A refused value
 * (ApiClientError) carries a message meant to be shown. Anything unexpected is
 * logged and reported generically: driver messages can carry query text and
 * parameters.
 */
function storageFailure(error: unknown, action: string): UserActionResult {
  if (error instanceof ApiClientError) {
    return failure(error.message);
  }
  if (isUniqueViolation(error)) {
    return failure("A user with this email already exists");
  }
  console.error(`Failed to ${action}:`, error);
  return failure(`Failed to ${action}`);
}

export async function createUserAction(formData: FormData): Promise<UserActionResult> {
  const session = await requirePermission("users:write");

  const email = String(formData.get("email") ?? "").trim();
  const name = formData.get("name") ? String(formData.get("name")).trim() : null;
  // "admin", "user", "viewer" or "custom:<id>"; anything else is "user".
  const assignment = parseRoleChoice(String(formData.get("role") ?? "user")) ?? { role: "user", customRoleId: null };
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return failure("Email and password are required");
  }
  const policyError = passwordPolicyMessage(password);
  if (policyError) {
    return failure(policyError);
  }

  // The new user's organisation (ee/multi-tenancy): an organisation user's
  // own, or the one a provider-level user is looking at.
  let organizationId: number | null;
  try {
    const requested = tenantOf(session.access) === null ? await dashboardCreateOrganization(session.access) : undefined;
    organizationId =
      tenantOf(session.access) === null && requested === undefined
        ? null
        : await organizationForNewRow(Number(session.user.id), requested);
    // Only roles the actor may grant and that fit the organisation; a custom role needs the license.
    await assertCanAssignOnCreate(session.access, assignment, organizationId);
  } catch (error) {
    return storageFailure(error, "create user");
  }

  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.default.hash(password, 12);

  let user: User;
  try {
    user = await createUser({
      email,
      name,
      role: assignment.role,
      customRoleId: assignment.customRoleId,
      organizationId,
      provider: "credentials",
      subject: email,
      passwordHash,
    });
  } catch (error) {
    return storageFailure(error, "create user");
  }

  await auditUserCreated(session.access, user);

  revalidatePath("/users");
  return { ok: true };
}

/**
 * Changes a user's role: "admin", "user", "viewer" or "custom:<id>" (the role
 * picker's values). assignRole applies the escalation guards and the license
 * check for custom roles and records the change in the audit log.
 */
export async function updateUserRoleAction(userId: number, role: string): Promise<UserActionResult> {
  const session = await requirePermission("users:write");
  const actorId = Number(session.user.id);

  if (actorId === userId) {
    return failure("Cannot change your own role");
  }
  // Server Action arguments come from the client; accept only known roles.
  const assignment = parseRoleChoice(role);
  if (!assignment) {
    return failure("Invalid role");
  }

  try {
    await assignRole(session.access, userId, assignment);
  } catch (error) {
    return storageFailure(error, "update user role");
  }

  revalidatePath("/users");
  return { ok: true };
}

export async function updateUserStatusAction(userId: number, status: string): Promise<UserActionResult> {
  const session = await requirePermission("users:write");
  const actorId = Number(session.user.id);

  if (actorId === userId) {
    return failure("Cannot change your own status");
  }
  if (!VALID_STATUSES.has(status)) {
    return failure("Invalid status");
  }

  try {
    await assertCanManageUserId(session.access, userId);
    await assertActiveAdminRemainsFor(session.access, { userId, status });
    await updateUserStatus(userId, status);
  } catch (error) {
    return storageFailure(error, "update user status");
  }

  await logAuditEvent({
    userId: actorId,
    action: "update",
    entityType: "user",
    entityId: userId,
    summary: `Changed user ${userId} status to ${status}`,
  });

  revalidatePath("/users");
  return { ok: true };
}

/**
 * Saves the edit dialog: name, email and the username the user signs in with
 * on the login page, in one transaction (see updateUserAccount), so a refused
 * username or email address leaves every field as it was and the reason comes
 * back as the error. A form without a username field leaves it alone.
 */
export async function updateUserInfoAction(userId: number, formData: FormData): Promise<UserActionResult> {
  const session = await requirePermission("users:write");
  const actorId = Number(session.user.id);
  try {
    await assertCanManageUserId(session.access, userId);
  } catch (error) {
    return storageFailure(error, "update user");
  }

  const name = formData.get("name") ? String(formData.get("name")).trim() : undefined;
  const email = formData.get("email") ? String(formData.get("email")).trim() : undefined;
  const username = formData.has("username") ? String(formData.get("username")) : undefined;

  let changed: Awaited<ReturnType<typeof updateUserAccount>>;
  try {
    changed = await updateUserAccount(userId, { name, email, username });
  } catch (error) {
    return storageFailure(error, "update user");
  }
  if (!changed) {
    return failure("User not found");
  }

  await logAuditEvent({
    userId: actorId,
    action: "update",
    entityType: "user",
    entityId: userId,
    summary: `Updated user ${userId} profile`,
  });
  if (changed.user.username !== changed.previousUsername) {
    await logAuditEvent({
      userId: actorId,
      action: "update",
      entityType: "user",
      entityId: userId,
      summary: `Changed user ${userId} sign-in username to ${changed.user.username}`,
      data: { previousUsername: changed.previousUsername, username: changed.user.username },
    });
  }

  revalidatePath("/users");
  return { ok: true };
}

export async function deleteUserAction(userId: number): Promise<UserActionResult> {
  const session = await requirePermission("users:write");
  const actorId = Number(session.user.id);

  if (actorId === userId) {
    return failure("Cannot delete your own account");
  }

  try {
    await assertCanManageUserId(session.access, userId);
    await assertActiveAdminRemainsFor(session.access, { userId, deleted: true });
    await deleteUser(userId);
  } catch (error) {
    return storageFailure(error, "delete user");
  }

  await logAuditEvent({
    userId: actorId,
    action: "delete",
    entityType: "user",
    entityId: userId,
    summary: `Deleted user ${userId}`,
  });

  revalidatePath("/users");
  return { ok: true };
}
