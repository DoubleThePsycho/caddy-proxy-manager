// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { PULL_REPLICA_NOT_FOUND, revokePullCredential, rotatePullCredential } from "@/ee/fleet/pull-replicas";
import { NO_STORE, parseRouteId } from "@/ee/fleet/http";

type Params = { params: Promise<{ id: string }> };

/** Issue a new credential (the old one stops working); shown in this reply only. Needs the license. */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "fleet:replicas");
    const id = parseRouteId((await params).id, PULL_REPLICA_NOT_FOUND);
    return NextResponse.json(await rotatePullCredential(id, userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Revoke the credential: the replica is refused until a new one is issued. No license needed. */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "fleet:replicas");
    const id = parseRouteId((await params).id, PULL_REPLICA_NOT_FOUND);
    return NextResponse.json(await revokePullCredential(id, userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
