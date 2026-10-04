// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { NO_STORE } from "@/ee/monetization/http";
import { listHostMonetization } from "@/ee/monetization/hosts";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "monetization:read");
    return NextResponse.json(await listHostMonetization(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
