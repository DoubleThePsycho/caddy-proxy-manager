// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { INSTANCE_NOT_FOUND, assignInstance } from "@/ee/fleet/environments";
import { parseRouteId, readJsonBody } from "@/ee/fleet/http";

type Params = { params: Promise<{ id: string }> };

/** `{ environmentId }` assigns the instance; `{ environmentId: null }` takes it out of its environment. */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { userId, access } = await requireApiPermission(request, "fleet:write");
    const id = parseRouteId((await params).id, INSTANCE_NOT_FOUND);
    return NextResponse.json(await assignInstance(id, await readJsonBody(request), { userId, access }));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
