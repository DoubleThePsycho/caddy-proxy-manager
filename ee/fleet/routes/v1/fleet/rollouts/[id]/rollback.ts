// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ROLLOUT_NOT_FOUND, rollbackRollout } from "@/ee/fleet/rollouts";
import { parseRouteId } from "@/ee/fleet/http";

type Params = { params: Promise<{ id: string }> };

/** Promote the revision the environment ran before this rollout. Body optional: `{ canary? }`. */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "fleet:promote");
    const id = parseRouteId((await params).id, ROLLOUT_NOT_FOUND);
    const text = await request.text();
    let body: unknown = undefined;
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        return NextResponse.json({ error: "Request body must be JSON" }, { status: 400 });
      }
    }
    return NextResponse.json(await rollbackRollout(id, body, userId), { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
