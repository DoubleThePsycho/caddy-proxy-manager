// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { listMembers, moveResources, parseOrganizationId } from "@/ee/multi-tenancy/service";
import { NO_STORE, readJsonBody } from "@/ee/multi-tenancy/http";
import { ApiValidationError } from "@/src/lib/api-errors";

type Params = { params: Promise<{ id: string }> };

/** The organisation's users. */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "organizations:read");
    return NextResponse.json(await listMembers(parseOrganizationId((await params).id)), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * Moves existing users into the organisation: {"userIds": [...]}. Needs the
 * license. To create a user in it, POST /api/v1/users with organizationId.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { access } = await requireApiPermission(request, "organizations:write");
    const id = parseOrganizationId((await params).id);
    const body = await readJsonBody(request);
    const userIds = (body as { userIds?: unknown } | null)?.userIds;
    if (!Array.isArray(userIds) || userIds.length === 0) throw new ApiValidationError("userIds must be a non-empty array of user ids");
    const result = await moveResources(access, {
      organizationId: id,
      proxyHostIds: [],
      certificateIds: [],
      accessListIds: [],
      groupIds: [],
      userIds: userIds.map((value) => {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
          throw new ApiValidationError("userIds must be a non-empty array of user ids");
        }
        return value;
      }),
    });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
