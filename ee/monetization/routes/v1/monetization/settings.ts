// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { NO_STORE, readJsonBody } from "@/ee/monetization/http";
import { getMonetizationOptionsView, saveMonetizationOptions } from "@/ee/monetization/options";

/** Usage history retention and how sync replicas serve monetized hosts. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "monetization:read");
    return NextResponse.json(await getMonetizationOptionsView(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * {usageRetentionMonths?, replicas?: {mode?, gateUrl?}}. Changing replica
 * serving also needs instances:write (checked by
 * saveMonetizationOptions): it decides what the master sends its replicas
 * and where they send their allowance credential.
 */
export async function PUT(request: NextRequest) {
  try {
    const { userId, access } = await requireApiPermission(request, "monetization:write");
    return NextResponse.json(await saveMonetizationOptions(await readJsonBody(request), userId, access), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
