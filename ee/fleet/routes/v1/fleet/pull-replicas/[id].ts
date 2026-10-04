// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { PULL_REPLICA_NOT_FOUND, deletePullReplica, getPullReplica } from "@/ee/fleet/pull-replicas";
import { NO_STORE, parseRouteId } from "@/ee/fleet/http";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "fleet:read");
    const id = parseRouteId((await params).id, PULL_REPLICA_NOT_FOUND);
    return NextResponse.json(await getPullReplica(id), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Delete the pull replica with its credential, key pin and fleet records. No license needed. */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "fleet:replicas");
    const id = parseRouteId((await params).id, PULL_REPLICA_NOT_FOUND);
    await deletePullReplica(id, userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
