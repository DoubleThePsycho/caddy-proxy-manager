// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { requireFeature } from "@/ee/licensing/store";
import { listSnapshots } from "@/ee/config-history/snapshots";
import { createManualSnapshot, deleteAllSnapshots, FEATURE } from "@/ee/config-history/service";

function intParam(value: string | null, fallback: number): number {
  if (value === null || value === "") return fallback;
  if (!/^\d{1,9}$/.test(value)) throw new ApiValidationError("limit and offset must be non-negative integers");
  return Number(value);
}

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "config_history:read");
    const params = request.nextUrl.searchParams;
    const limit = Math.min(Math.max(intParam(params.get("limit"), 50), 1), 500);
    const offset = intParam(params.get("offset"), 0);
    const { snapshots, total } = await listSnapshots({ limit, offset });
    return NextResponse.json({ snapshots, total, limit, offset });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "config_history:write");
    await requireFeature(FEATURE);
    let body: unknown = {};
    const raw = await request.text();
    if (raw.trim().length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        throw new ApiValidationError("Request body must be JSON");
      }
    }
    const snapshot = await createManualSnapshot(userId, body);
    return NextResponse.json(snapshot, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Deletes every snapshot. Needs no license: winding the feature down never does. */
export async function DELETE(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "config_history:write");
    return NextResponse.json({ deleted: await deleteAllSnapshots(userId) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
