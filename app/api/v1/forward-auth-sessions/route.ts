import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import {
  listForwardAuthSessions,
  deleteUserForwardAuthSessions
} from "@/src/lib/models/forward-auth";
import { assertCanManageUserId } from "@/ee/custom-roles/service";
import { readOrganizationFilterParam } from "@/ee/multi-tenancy/scope";
import { parseRowId } from "@/src/lib/row-ids";

export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "users:read");
    // Organisation users see their organisation's users' sessions only.
    const sessions = await listForwardAuthSessions(readOrganizationFilterParam(access, request.nextUrl.searchParams.get("organizationId")));
    return NextResponse.json(sessions);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "users:write");
    const rawUserId = request.nextUrl.searchParams.get("userId");
    if (!rawUserId) {
      return NextResponse.json({ error: "userId query parameter is required" }, { status: 400 });
    }
    const userId = parseRowId(rawUserId);
    if (userId === null) {
      return NextResponse.json({ error: "userId query parameter must be a user id" }, { status: 400 });
    }
    await assertCanManageUserId(access, userId);
    await deleteUserForwardAuthSessions(userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
