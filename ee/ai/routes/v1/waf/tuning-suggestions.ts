// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { generateWafTuningSuggestions } from "@/ee/ai/waf-tuning";
import { NO_STORE } from "@/ee/alerting/http";

function readExplain(value: string | null): boolean {
  if (value === null || value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new ApiValidationError("explain must be true or false");
}

/** Generates suggestions from the WAF events; needs a license with the AI analyst. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "waf:read");
    const explain = readExplain(request.nextUrl.searchParams.get("explain"));
    return NextResponse.json(await generateWafTuningSuggestions({ explain }), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
