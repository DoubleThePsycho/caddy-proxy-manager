// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { NO_STORE } from "@/ee/monetization/http";
import { getMonetizationOverview } from "@/ee/monetization/overview";

/** Month totals, the last 30 days and the top consumers from the ledger, and the balances held. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "monetization:read");
    return NextResponse.json(await getMonetizationOverview(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
