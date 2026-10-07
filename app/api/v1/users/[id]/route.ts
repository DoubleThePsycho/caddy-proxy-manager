import { NextRequest, NextResponse } from "next/server";
import { requireApiUser, requireApiPermission, apiErrorResponse, ApiAuthError, getApiAccess } from "@/src/lib/api-auth";
import {
  getUserById,
  updateUserAccount,
  updateUserStatus,
  deleteUser,
} from "@/src/lib/models/user";
import { logAuditEvent } from "@/src/lib/audit";
import { SIGN_IN_USERNAME_RULES_MESSAGE } from "@/src/lib/login-username";
import { appDb } from "@/src/lib/db";
import { assertBreakGlassAdminRemains } from "@/ee/sso/enforcement-store";
import { can, isBuiltInRole } from "@/src/lib/permissions";
import {
  assertActiveAdminRemainsFor,
  assertCanAssignRole,
  assertCanManageUserId,
  assignRole,
  readRoleAssignment,
} from "@/ee/custom-roles/service";
import { parseRowId, routeRowId } from "@/src/lib/row-ids";

function stripPasswordHash(user: Record<string, unknown>) {
  const { passwordHash: _, ...rest } = user;
  void _;
  return rest;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // A token with scopes gets here only through users:read below.
    const auth = await requireApiUser(request, { allowScopedToken: true });
    const { id } = await params;
    const targetId = parseRowId(id);

    // Without users:read a caller can only view themselves, and a token with
    // scopes not even that: its scopes do not cover the owner's account.
    const access = await getApiAccess(auth);
    if (!can(access, "users:read") && (auth.userId !== targetId || auth.tokenScopes)) {
      throw new ApiAuthError("Forbidden", 403);
    }

    const user = targetId === null ? null : await getUserById(targetId);
    if (!user) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(stripPasswordHash(user as unknown as Record<string, unknown>));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireApiPermission(request, "users:write");
    const { id } = await params;
    const targetId = routeRowId(id, "Not found");
    const body = await request.json();

    // Everything that can be refused up front is, before anything is written.
    // null means "no change", so a GET body sent back as it is still works.
    if (body.username != null && typeof body.username !== "string") {
      return NextResponse.json({ error: SIGN_IN_USERNAME_RULES_MESSAGE }, { status: 400 });
    }
    if (body.email != null && typeof body.email !== "string") {
      return NextResponse.json({ error: "Email must be a string" }, { status: 400 });
    }
    // A role that is not a built-in role is ignored, as before custom roles.
    const assignment = readRoleAssignment({
      role: isBuiltInRole(body.role) ? body.role : undefined,
      customRoleId: body.customRoleId,
    });
    const status = body.status && ["active", "disabled"].includes(body.status) ? body.status as string : null;
    if (assignment && auth.userId === targetId) {
      return NextResponse.json({ error: "Cannot change your own role" }, { status: 400 });
    }
    if (status && auth.userId === targetId) {
      return NextResponse.json({ error: "Cannot change your own status" }, { status: 400 });
    }
    // A non-administrator only edits users whose access they hold themselves.
    if (!(await getUserById(targetId))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    await assertCanManageUserId(auth.access, targetId);
    // Role and status guards (escalation, the last administrator, enforced SSO
    // lockout) before anything is written.
    // assignRole and updateUserStatus check again in their own transactions.
    if (assignment) {
      await assertCanAssignRole(auth.access, targetId, assignment);
    }
    if (status) {
      await assertActiveAdminRemainsFor(auth.access, { userId: targetId, status });
    }
    if (assignment || status) {
      await assertBreakGlassAdminRemains(appDb, {
        userId: targetId,
        ...(assignment ? { role: assignment.role } : {}),
        ...(status ? { status } : {}),
      });
    }

    // Username and profile in one transaction: a username or email address
    // that is refused (400) leaves the other fields unchanged too.
    const accountFields: Parameters<typeof updateUserAccount>[1] = {};
    if (typeof body.username === "string") accountFields.username = body.username;
    if (typeof body.email === "string") accountFields.email = body.email;
    if (body.name !== undefined) accountFields.name = body.name;
    if (body.avatarUrl !== undefined) accountFields.avatarUrl = body.avatarUrl;
    if (Object.keys(accountFields).length > 0) {
      const changed = await updateUserAccount(targetId, accountFields);
      if (!changed) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      if (changed.user.username !== changed.previousUsername) {
        await logAuditEvent({
          userId: auth.userId,
          action: "update",
          entityType: "user",
          entityId: targetId,
          summary: `Changed user ${targetId} sign-in username to ${changed.user.username}`,
          data: { previousUsername: changed.previousUsername, username: changed.user.username },
        });
      }
    }

    if (assignment) {
      // Records the change in the audit log.
      await assignRole(auth.access, targetId, assignment);
    }
    if (status) {
      await updateUserStatus(targetId, status);
    }

    const user = await getUserById(targetId);
    if (!user) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(stripPasswordHash(user as unknown as Record<string, unknown>));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireApiPermission(request, "users:write");
    const { id } = await params;
    const targetId = routeRowId(id, "Not found");

    if (auth.userId === targetId) {
      return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 });
    }

    const user = await getUserById(targetId);
    if (!user) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    await assertCanManageUserId(auth.access, targetId);
    await assertActiveAdminRemainsFor(auth.access, { userId: targetId, deleted: true });

    await deleteUser(targetId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
