// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { INSTANCE_NOT_FOUND } from "@/ee/fleet/environments";
import { resyncInstance } from "@/ee/fleet/rollouts";
import { NO_STORE, parseRouteId } from "@/ee/fleet/http";

type Params = { params: Promise<{ id: string }> };

/** Push to the instance what it should run (its environment's revision, or the master's configuration). */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "fleet:promote");
    const id = parseRouteId((await params).id, INSTANCE_NOT_FOUND);
    return NextResponse.json(await resyncInstance(id, userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
