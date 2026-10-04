import { NextRequest, NextResponse } from "next/server";
import { requireApiUser, requireApiPermission, apiErrorResponse, ApiAuthError, getApiAccess } from "@/src/lib/api-auth";
import { can } from "@/src/lib/permissions";
import { assertCanManageUserId } from "@/ee/custom-roles/service";
import { ApiClientError } from "@/src/lib/api-errors";
import { findUserInScope } from "@/src/lib/access-scope";
import { adminResetUserMfa, getMfaStatus } from "@/src/lib/mfa";
import { routeRowId } from "@/src/lib/row-ids";

const NO_STORE = { "Cache-Control": "no-store" };

function parseUserId(id: string): number {
  return routeRowId(id, "User not found");
}

/** A user's MFA state (users:read, or the user themself). Never includes secrets. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // A token with scopes gets here only through users:read below.
    const auth = await requireApiUser(request, { allowScopedToken: true });
    const targetId = parseUserId((await params).id);
    const access = await getApiAccess(auth);
    if (!can(access, "users:read") && (auth.userId !== targetId || auth.tokenScopes)) {
      throw new ApiAuthError("Forbidden", 403);
    }
    // A user of another organisation (ee/multi-tenancy) is not found, as a missing one.
    if (!(await findUserInScope(access, targetId))) throw new ApiClientError("User not found", 404);
    return NextResponse.json(await getMfaStatus(targetId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * Turns MFA off for another user, for example after they lost their
 * authenticator and backup codes. Recorded in the audit log as mfa_reset.
 * Users turn off their own MFA from Profile, with their password.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId, access } = await requireApiPermission(request, "users:write");
    const targetId = parseUserId((await params).id);
    await assertCanManageUserId(access, targetId);
    return NextResponse.json(await adminResetUserMfa(targetId, userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
