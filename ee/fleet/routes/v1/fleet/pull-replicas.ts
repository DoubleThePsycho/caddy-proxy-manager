// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { createPullReplica, listPullReplicas } from "@/ee/fleet/pull-replicas";
import { NO_STORE, readJsonBody } from "@/ee/fleet/http";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "fleet:read");
    return NextResponse.json(await listPullReplicas(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Add a pull replica; the credential and the replica's environment are in this reply only. */
export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "fleet:replicas");
    return NextResponse.json(await createPullReplica(await readJsonBody(request), userId), { status: 201, headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
