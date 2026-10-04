// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission } from "@/src/lib/api-auth";
import { configurationErrorResponse } from "@/src/lib/config-api";
import { requireFeature } from "@/ee/licensing/store";
import { FEATURE, parseSnapshotId, restoreSnapshot } from "@/ee/config-history/service";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "config_history:restore");
    await requireFeature(FEATURE);
    const { id } = await params;
    return NextResponse.json(await restoreSnapshot(parseSnapshotId(id), userId));
  } catch (error) {
    return configurationErrorResponse(error);
  }
}
