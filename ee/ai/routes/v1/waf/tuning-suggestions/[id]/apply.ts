// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { applyWafTuningSuggestion } from "@/ee/ai/waf-tuning";
import { NO_STORE } from "@/ee/alerting/http";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireApiPermission(request, "waf:write");
    const { id } = await params;
    return NextResponse.json(await applyWafTuningSuggestion(id, userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
