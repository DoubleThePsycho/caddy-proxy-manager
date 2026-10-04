// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { createEnvironment, listEnvironments } from "@/ee/fleet/environments";
import { readJsonBody } from "@/ee/fleet/http";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "fleet:read");
    return NextResponse.json(await listEnvironments());
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "fleet:write");
    return NextResponse.json(await createEnvironment(await readJsonBody(request), userId), { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
