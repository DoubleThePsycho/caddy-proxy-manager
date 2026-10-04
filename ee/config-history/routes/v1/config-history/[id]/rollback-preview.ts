// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { parseSnapshotId } from "@/ee/config-history/service";
import { previewRollback } from "@/ee/config-history/versions";

type Params = { params: Promise<{ id: string }> };

/**
 * What rolling back to this version would do: hosts and settings that
 * change, later changes it undoes, later changes to the same hosts, approval
 * policies that would refuse it and how many Caddy nodes reload. Changes
 * nothing.
 */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { access } = await requireApiPermission(request, "config_history:read");
    const { id } = await params;
    return NextResponse.json(await previewRollback(parseSnapshotId(id), access), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
