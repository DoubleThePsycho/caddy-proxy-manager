import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { listUsers, createUser } from "@/src/lib/models/user";
import { passwordPolicyMessage } from "@/src/lib/password-policy";
import { SIGN_IN_USERNAME_RULES_MESSAGE } from "@/src/lib/login-username";
import { isBuiltInRole } from "@/src/lib/permissions";
import { assertCanAssignOnCreate, auditUserCreated, readRoleAssignment } from "@/ee/custom-roles/service";
import { organizationForNewRow, readOrganizationFilterParam } from "@/ee/multi-tenancy/scope";
import { tenantOf } from "@/src/lib/permissions";

function stripPasswordHash(user: Record<string, unknown>) {
  const { passwordHash: _, ...rest } = user;
  void _;
  return rest;
}

export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "users:read");
    // Organisation users get their organisation's users; provider-level users can filter (?organizationId=).
    const users = await listUsers(readOrganizationFilterParam(access, request.nextUrl.searchParams.get("organizationId")));
    return NextResponse.json(users.map(u => stripPasswordHash(u as unknown as Record<string, unknown>)));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { access, userId: actorUserId } = await requireApiPermission(request, "users:write");
    const body = await request.json();
    const inOrganization = tenantOf(access) !== null || (body.organizationId !== undefined && body.organizationId !== null);

    const email = String(body.email ?? "").trim();
    const password = String(body.password ?? "");
    const name = body.name ? String(body.name).trim() : null;
    // A role that is not a built-in role becomes "user", as before custom
    // roles; a custom role is given with customRoleId.
    const withCustomRole = body.customRoleId !== undefined && body.customRoleId !== null;
    const assignment = readRoleAssignment({
      role: isBuiltInRole(body.role) || (inOrganization && body.role === "org_admin") ? body.role : withCustomRole ? undefined : "user",
      customRoleId: withCustomRole ? body.customRoleId : undefined,
    })!;
    // Optional. Without one the user gets their own email when it can be a
    // username (see createUser); createUser checks one that is given.
    const username: unknown = body.username ?? null;

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
    }
    if (username !== null && typeof username !== "string") {
      return NextResponse.json({ error: SIGN_IN_USERNAME_RULES_MESSAGE }, { status: 400 });
    }
    const policyError = passwordPolicyMessage(password);
    if (policyError) {
      return NextResponse.json({ error: policyError }, { status: 400 });
    }
    // The new user's organisation (ee/multi-tenancy): an organisation user's
    // own; for a provider-level caller, organizationId needs organizations:write
    // and the license.
    const organizationId =
      tenantOf(access) === null && (body.organizationId === undefined || body.organizationId === null)
        ? null
        : await organizationForNewRow(actorUserId, body.organizationId);
    // Only roles the caller may grant and that fit the organisation; a custom role needs the license.
    await assertCanAssignOnCreate(access, assignment, organizationId);

    const bcrypt = await import("bcryptjs");
    const passwordHash = await bcrypt.default.hash(password, 12);

    const user = await createUser({
      email,
      name,
      role: assignment.role,
      customRoleId: assignment.customRoleId,
      organizationId,
      provider: "credentials",
      subject: email,
      passwordHash,
      username,
    });
    await auditUserCreated(access, user);

    return NextResponse.json(stripPasswordHash(user as unknown as Record<string, unknown>), { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
