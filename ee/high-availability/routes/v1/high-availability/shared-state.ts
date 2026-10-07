// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { NO_STORE } from "@/ee/high-availability/http";
import { sharedStateErrorResponse } from "@/ee/high-availability/shared-state/http";
import { getSharedStateView, removeSharedState, saveSharedState } from "@/ee/high-availability/shared-state/service";

/** Whether the web nodes keep request-path state in Redis or Valkey. No secrets. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "high_availability:read");
    return NextResponse.json(await getSharedStateView(), { headers: NO_STORE });
  } catch (error) {
    return sharedStateErrorResponse(error);
  }
}

/** Turns shared state on or off, or changes its key prefix. */
export async function PUT(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "high_availability:write");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiValidationError("Request body must be JSON");
    }
    return NextResponse.json(await saveSharedState(body, userId), { headers: NO_STORE });
  } catch (error) {
    return sharedStateErrorResponse(error);
  }
}

/** Turns shared state off and forgets the setting, even when the server cannot be reached. */
export async function DELETE(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "high_availability:write");
    return NextResponse.json(await removeSharedState(userId), { headers: NO_STORE });
  } catch (error) {
    return sharedStateErrorResponse(error);
  }
}
